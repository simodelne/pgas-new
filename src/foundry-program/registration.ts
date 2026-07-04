import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createProgramAdapters,
  createToolRegistry,
  loadSpecWithPatterns,
  type ProgramEntry,
} from '@simodelne/pgas-server/plugin.js';
import { handlers, reactionHandlers } from './handlers.js';
import { registerPgasNewTools } from './tools.js';

// Every action in this set MUST declare `channel: widget_output` in
// specs.yml's action_map. The engine's NoticeContinuation consumer publishes
// notice_emitted (which fires the system_mode_entry auto_continuation trigger)
// ONLY for EffectActions on the widget_output channel — an auto-continue
// action on any other Out channel silently never continues, stalling the
// session at the next mode entry. This exact stall shipped with the
// domain_synthesis wiring (synthesize_domain_logic on domain_synthesis_output)
// and broke live UAT scenarios a/b/c at domain_synthesis -> branch_write on
// 2026-07-03. tests/unit/foundry-auto-continue-channels.test.ts pins the
// invariant.
export const AUTO_CONTINUE_ACTIONS = new Set([
  'confirm_design',
  'reject_design_and_revise_q1',
  'reject_design_and_revise_q2',
  'reject_design_and_revise_q3',
  'reject_design_and_revise_q4',
  'reject_design_and_revise_q5',
  'reject_design_and_revise_q6',
  'authorize_standalone_target',
  'load_wiring_manifest',
  'authorize_existing_repo_target',
  'synthesize_program_spec',
  'approve_artifact_plan',
  'synthesize_domain_logic',
  'write_scaffold_artifacts',
  'run_static_verification',
  'run_smoke_verification',
  'confirm_live_provider_intent',
  'run_live_provider_verification',
  'git_rebase_latest',
  'run_rebase_static_verification',
]);

export function createPgasNewFoundryProgramEntry(): ProgramEntry {
  const dirname = path.dirname(fileURLToPath(import.meta.url));
  const { spec: loaded } = loadSpecWithPatterns(path.join(dirname, 'specs.yml'));
  // The foundry's spec at src/foundry-program/specs.yml declares its own
  // notebook actions (`record_user_note`, `pin_notebook_note` at lines
  // 601-602) explicitly scoped to the modes where free-form user notes
  // are valuable (intake_intelligence, architecture_design, curator_request).
  //
  // The engine's enableNotebook() helper adds five MORE notebook tools
  // (record_note, pin_note, read_note, unpin_note, delete_note) on top of
  // every mode it targets. Even after Phase 5.12 scoped that to just
  // intake_intelligence, the full §10 sweep at 6f6fbf5c showed Qwen
  // non-deterministically picking record_note over the actual Q-action
  // (Scenario A failed at record_q3_stages → record_note), and downstream
  // modes still saw __fallback__ on /approve because plan_artifacts
  // re-fired even when notebook was absent.
  //
  // Root product fix: do NOT layer the engine's notebook surface on top
  // of the foundry's already-scoped spec-declared notebook actions. The
  // spec's explicit per-mode vocabulary stays authoritative; LLM tool
  // selection becomes more deterministic; gate-action tools (confirm_design,
  // approve_artifact_plan, record_q*_*) are no longer crowded by competing
  // engine-provided tools.
  const spec = loaded;
  const toolRegistry = createToolRegistry();
  registerPgasNewTools(toolRegistry);

  return {
    spec,
    reactionHandlers,
    continuationPolicy: {
      modeEntryAutoContinue: false,
    },
    sessionOptions: {
      reliability: {
        onGateVerdict: (event) => {
          if (process.env.PGAS_FOUNDRY_DEBUG !== '1') return;
          if (event.gate !== 'GKPrecondition') return;
          if (event.actionContext?.name !== 'approve_artifact_plan') return;
          console.error(
            '[PGAS_FOUNDRY_DEBUG] approve_artifact_plan gate verdict',
            JSON.stringify({
              roundNumber: event.roundNumber,
              attemptNumber: event.attemptNumber,
              passed: event.passed,
              error: event.error,
              actionContext: event.actionContext,
            }),
          );
        },
      },
    },
    createAdapters: (ctx) => {
      const adapters = createProgramAdapters(spec, ctx, handlers);
      if (spec.tools) {
        for (const [name, decl] of spec.tools) {
          if (toolRegistry.has(name)) {
            adapters.outputs.set(decl.channelId, toolRegistry.createAdapter(name));
          }
        }
      }
      exposeSynthesisMarkerInTerminalPayload(adapters);
      exposeAutoContinueIntentInTerminalPayload(adapters);
      return adapters;
    },
  };
}

export const createPgasNewProgramEntry = createPgasNewFoundryProgramEntry;

type ProgramAdapters = ReturnType<typeof createProgramAdapters>;

function exposeSynthesisMarkerInTerminalPayload(adapters: ProgramAdapters): void {
  for (const adapter of adapters.outputs.values()) {
    const dispatch = adapter.dispatch.bind(adapter) as typeof adapter.dispatch;
    adapter.dispatch = async (payload: Parameters<typeof adapter.dispatch>[0]) => {
      const result = await dispatch(payload);
      if (isSynthesizeProgramSpecEffect(payload) && isSynthesisMarker(result)) {
        payload.payload = mergePayloadMarker(payload.payload, result);
      }
      return result;
    };
  }
}

function exposeAutoContinueIntentInTerminalPayload(adapters: ProgramAdapters): void {
  for (const adapter of adapters.outputs.values()) {
    const dispatch = adapter.dispatch.bind(adapter) as typeof adapter.dispatch;
    adapter.dispatch = async (payload: Parameters<typeof adapter.dispatch>[0]) => {
      const result = await dispatch(payload);
      if (isAutoContinueEffect(payload)) {
        payload.payload = mergePayloadMarker(payload.payload, {
          intent: 'present_information',
          auto_continue: true,
        });
      }
      return result;
    };
  }
}

function isSynthesizeProgramSpecEffect(
  payload: unknown,
): payload is { kind: 'EffectAction'; name: 'synthesize_program_spec'; payload: unknown } {
  return (
    !!payload &&
    typeof payload === 'object' &&
    !Array.isArray(payload) &&
    (payload as { kind?: unknown }).kind === 'EffectAction' &&
    (payload as { name?: unknown }).name === 'synthesize_program_spec'
  );
}

function isAutoContinueEffect(payload: unknown): payload is { kind: 'EffectAction'; name: string; payload: unknown } {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return false;
  }
  if ((payload as { kind?: unknown }).kind !== 'EffectAction') {
    return false;
  }
  const name = (payload as { name?: unknown }).name;
  if (typeof name !== 'string') {
    return false;
  }
  if (name === 'select_repo_target') {
    return selectedContinuableRepoTarget((payload as { payload?: unknown }).payload);
  }
  return AUTO_CONTINUE_ACTIONS.has(name);
}

function selectedContinuableRepoTarget(payload: unknown): boolean {
  const targetKind = payload && typeof payload === 'object' && !Array.isArray(payload)
    ? (payload as { target_kind?: unknown }).target_kind
    : undefined;
  return (
    targetKind === 'existing_repo' ||
    targetKind === 'standalone_repo'
  );
}

function isSynthesisMarker(result: unknown): result is {
  kind: 'mechanical_synthesis';
  no_llm_call: true;
  mode_names: unknown;
  sha256: string;
} {
  return (
    !!result &&
    typeof result === 'object' &&
    !Array.isArray(result) &&
    (result as { kind?: unknown }).kind === 'mechanical_synthesis' &&
    (result as { no_llm_call?: unknown }).no_llm_call === true &&
    Array.isArray((result as { mode_names?: unknown }).mode_names) &&
    typeof (result as { sha256?: unknown }).sha256 === 'string'
  );
}

function mergePayloadMarker(payload: unknown, marker: Record<string, unknown>): Record<string, unknown> {
  if (payload && typeof payload === 'object' && !Array.isArray(payload)) {
    return { ...(payload as Record<string, unknown>), ...marker };
  }
  return marker;
}
