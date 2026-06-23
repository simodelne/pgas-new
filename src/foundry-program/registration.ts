import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createProgramAdapters,
  createToolRegistry,
  enableNotebook,
  loadSpecWithPatterns,
  type ProgramEntry,
} from '@simodelne/pgas-server/plugin.js';
import { handlers, reactionHandlers } from './handlers.js';
import { registerPgasNewTools } from './tools.js';

const AUTO_CONTINUE_ACTIONS = new Set([
  'confirm_design',
  'authorize_standalone_target',
  'authorize_existing_repo_target',
  'synthesize_program_spec',
  'approve_artifact_plan',
  'write_scaffold_artifacts',
  'run_static_verification',
  'confirm_live_provider_intent',
  'run_live_provider_verification',
  'git_rebase_latest',
  'run_rebase_static_verification',
]);

export function createPgasNewFoundryProgramEntry(): ProgramEntry {
  const dirname = path.dirname(fileURLToPath(import.meta.url));
  const { spec: loaded } = loadSpecWithPatterns(path.join(dirname, 'specs.yml'));
  const spec = enableNotebook(loaded, { excludeTerminal: true });
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
  return (
    !!payload &&
    typeof payload === 'object' &&
    !Array.isArray(payload) &&
    (payload as { kind?: unknown }).kind === 'EffectAction' &&
    typeof (payload as { name?: unknown }).name === 'string' &&
    AUTO_CONTINUE_ACTIONS.has((payload as { name: string }).name)
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
