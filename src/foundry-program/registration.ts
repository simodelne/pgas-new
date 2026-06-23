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

export function createPgasNewFoundryProgramEntry(): ProgramEntry {
  const dirname = path.dirname(fileURLToPath(import.meta.url));
  const { spec: loaded } = loadSpecWithPatterns(path.join(dirname, 'specs.yml'));
  const spec = enableNotebook(loaded, { excludeTerminal: true });
  const toolRegistry = createToolRegistry();
  registerPgasNewTools(toolRegistry);

  return {
    spec,
    reactionHandlers,
    createAdapters: (ctx) => {
      const adapters = createProgramAdapters(spec, ctx, handlers);
      if (spec.tools) {
        for (const [name, decl] of spec.tools) {
          if (toolRegistry.has(name)) {
            adapters.outputs.set(decl.channelId, toolRegistry.createAdapter(name));
          }
        }
      }
      return adapters;
    },
  };
}

export const createPgasNewProgramEntry = createPgasNewFoundryProgramEntry;
