import { isRecord } from '../util/guards.js';
import {
  createCompositeEffectAdapter,
  type CompositeEffectChild,
  type CompositeEffectChildContext,
  type CompositeEffectEnvelope,
} from '@simodelne/pgas-server/plugin.js';
import { isAllowedPgasServerImport, isBannedImport } from '../pgas-new/version.js';

// ---------------------------------------------------------------------------
// Opt-in parallel-effect feature (v3.3).
//
// `run_parallel_static_checks` is an OPTIONAL packed action in static_verify:
// instead of firing the single-call npm_typecheck / npm_test /
// run_static_verification actions (which stay the DEFAULT), the author MAY
// pack a set of independent static checks into ONE EffectAction. Its handler
// delegates to createCompositeEffectAdapter, whose children run CONCURRENTLY
// (Promise.all) and aggregate into a single CompositeEffectEnvelope written to
// the action's result_path (graduation.composite_checks).
//
// Multiplicity rides on the action payload (imports[], modes[], evidence{}):
// the formal one-EffectAction-per-round core (I-1 Terminal Singularity) is
// untouched, the channel stays synchronous so ER coupling holds (one Value,
// one sync path), and the engine's ACTION_NEEDS_HANDLER wiring contract is
// satisfied because a real handler is registered.
//
// Each child is a real, independent, side-effect-free check that uses
// pgas-new's OWN governance logic (the public-import boundary). A child that
// fails throws; the adapter records it as a failed child and aggregates the
// envelope status to "partial" — consumer-side handling, never a thrown effect.
// ---------------------------------------------------------------------------

/** Stable channel id for the opt-in composite static-checks output. */
export const COMPOSITE_STATIC_CHECKS_CHANNEL = 'composite_checks_output';

/**
 * Args the author packs onto the single action. The handler forwards its full
 * payload to the adapter, so each child sees those args as top-level fields on
 * ctx.payload (alongside engine-injected fields like `domain`, which the
 * children ignore).
 */
function packedArgs(ctx: CompositeEffectChildContext): Record<string, unknown> {
  const payload = ctx.payload;
  return payload && typeof payload === 'object' && !Array.isArray(payload)
    ? (payload as Record<string, unknown>)
    : {};
}

function toStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
}

/**
 * The fixed child set for the composite static-checks adapter. Each child reads
 * its slice from the packed action payload, so the author controls how much
 * work to pack while the child set (and therefore the envelope shape) stays
 * declarative and testable.
 */
export function createStaticCheckChildren(): CompositeEffectChild[] {
  return [
    {
      id: 'import_boundary',
      name: 'public-import boundary scan',
      run: async (ctx) => {
        const imports = toStringArray(packedArgs(ctx).imports);
        const violations = imports.filter(
          (specifier) =>
            isBannedImport(specifier) ||
            (specifier.startsWith('@simodelne/pgas-server') &&
              !isAllowedPgasServerImport(specifier)),
        );
        if (violations.length > 0) {
          throw new Error(
            `import_boundary: ${violations.length} disallowed import(s): ${violations.join(', ')}`,
          );
        }
        return { check: 'import_boundary', scanned: imports.length, violations: 0 };
      },
    },
    {
      id: 'spec_modes',
      name: 'declared-mode terminal-reachability',
      run: async (ctx) => {
        const modes = toStringArray(packedArgs(ctx).modes);
        if (modes.length === 0) {
          throw new Error('spec_modes: no modes declared in packed payload');
        }
        const hasTerminal = modes.includes('complete') || modes.includes('blocked');
        if (!hasTerminal) {
          throw new Error('spec_modes: no terminal mode (complete|blocked) declared');
        }
        return { check: 'spec_modes', count: modes.length, terminal: true };
      },
    },
    {
      id: 'evidence_shape',
      name: 'verification-evidence shape',
      run: async (ctx) => {
        const evidence = packedArgs(ctx).evidence;
        const ok =
          !!evidence &&
          typeof evidence === 'object' &&
          !Array.isArray(evidence) &&
          'status' in (evidence as Record<string, unknown>) &&
          'evidence_id' in (evidence as Record<string, unknown>);
        if (!ok) {
          throw new Error('evidence_shape: evidence must carry both status and evidence_id');
        }
        return { check: 'evidence_shape', ok: true };
      },
    },
  ];
}

// One adapter instance is enough — children are pure and read all per-call
// state from the dispatched payload.
let adapter: ReturnType<typeof createCompositeEffectAdapter> | undefined;

function compositeStaticChecksAdapter(): ReturnType<typeof createCompositeEffectAdapter> {
  adapter ??= createCompositeEffectAdapter(
    COMPOSITE_STATIC_CHECKS_CHANNEL,
    createStaticCheckChildren(),
  );
  return adapter;
}

/**
 * Handler entry point for `run_parallel_static_checks`. Delegates to the
 * published composite-effect adapter and returns the combined envelope, which
 * the engine writes to the action's result_path.
 */
export async function runCompositeStaticChecks(
  payload: Record<string, unknown>,
): Promise<CompositeEffectEnvelope> {
  return (await compositeStaticChecksAdapter().dispatch(
    payload as never,
  )) as CompositeEffectEnvelope;
}

/**
 * Confirmation-pairing drift check for generated specs: when pairing protects
 * a collection prefix, every action whose declarative mutations write under
 * that prefix must be listed as a terminal. This catches future edits that add
 * a collection write but forget to extend `confirmation_pairing.terminals`.
 */
export function assertConfirmationPairingTerminals(spec: unknown): void {
  if (!isRecord(spec)) {
    throw new Error('confirmation_pairing lint requires a parsed spec object');
  }
  const pairing = spec.confirmation_pairing;
  if (pairing === undefined || pairing === null) {
    return;
  }
  if (!isRecord(pairing)) {
    throw new Error('confirmation_pairing must be a mapping');
  }
  const prefixes = stringArray(pairing.prefixes);
  if (prefixes.length === 0) {
    return;
  }
  const terminals = new Set(stringArray(pairing.terminals));
  const actionMap = isRecord(spec.action_map) ? spec.action_map : {};

  const missing: string[] = [];
  for (const [actionName, action] of Object.entries(actionMap)) {
    if (!isRecord(action)) {
      continue;
    }
    const mutations = Array.isArray(action.mutations) ? action.mutations : [];
    const writesProtectedPrefix = mutations.some((mutation) => {
      if (!isRecord(mutation) || typeof mutation.path !== 'string') {
        return false;
      }
      return prefixes.some((prefix) => pathWithinPrefix(mutation.path as string, prefix));
    });
    if (writesProtectedPrefix && !terminals.has(actionName)) {
      missing.push(actionName);
    }
  }

  if (missing.length > 0) {
    throw new Error(
      `confirmation_pairing terminals missing prefix-writing action(s): ${missing.join(', ')}`,
    );
  }
}

function pathWithinPrefix(path: string, prefix: string): boolean {
  return path === prefix || path.startsWith(`${prefix}.`);
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}
