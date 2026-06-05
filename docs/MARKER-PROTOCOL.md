# Marker protocol

The plugin's `/pgas-new-program` command injects new program
registration into the consumer's existing `server/index.ts` (or
equivalent). To avoid having to re-implement file-shape detection for
every consumer, the scaffold places **marker comments** at the
canonical injection sites.

## The four markers

```
// [pgas-plugin:program-registry] — auto-injected program imports below
// [pgas-plugin:spec-registry] — auto-injected spec loads below
// [pgas-plugin:handler-registry] — auto-injected handler imports below
// [pgas-plugin:program-registration] — auto-injected `registry.register(...)` calls below
```

All four are placed in the scaffolded
`templates/new-consumer/server/index.ts.tmpl`. **All four MUST remain in
the file** even though, under the registration.ts convention (below),
only two of them ever receive injected content. Never remove or rename a
marker — doing so breaks re-scaffolds of existing consumers and is a
plugin **major**-version change (see "When to update markers").

## The recognizing regex

`/pgas-new-program` uses this exact pattern (anchored to the start of
the comment to avoid accidental matches inside strings):

```regex
^\s*// \[pgas-plugin:(program-registry|spec-registry|handler-registry|program-registration)\]
```

## Where new content is inserted

**Above** the marker line. The marker stays put — only new lines are
added between the existing code above and the marker.

## The registration.ts convention — which markers get content

The scaffolded program ships a `programs/<name>/registration.ts` that
encapsulates spec-loading and handler-binding behind a single
`createProgramEntry()` factory (exported as
`create<Pascal>ProgramEntry`). Because that shim owns spec-load and
handler-import, wiring a program into the server needs only **two**
lines — an import and a `registry.register(...)` call. So of the four
markers:

| Marker | Injected content | Rationale |
|--------|------------------|-----------|
| `program-registry` | **one `import` line** — imports the program's `create<Pascal>ProgramEntry` factory | the factory is the program's single entry point |
| `program-registration` | **one `registry.register(...)` line** | registers the entry the factory returns |
| `spec-registry` | **none — stays empty** | spec-loading lives inside `registration.ts` |
| `handler-registry` | **none — stays empty** | handler imports live inside `registration.ts` |

The two empty markers are **intentionally** left in place. They exist
for:

- **Backward compatibility** — a consumer scaffolded before the
  registration.ts convention may have inline spec-load / handler-import
  lines above these markers; the command must not disturb them.
- **Inline-wiring consumers** — a consumer that deliberately wires a
  program *without* a `registration.ts` shim (loading the spec and
  importing handlers directly in `server/index.ts`) uses these two
  markers as their injection sites. The registration.ts convention is
  the default, not the only, shape.

## Worked example (registration.ts convention)

Example before, for a server constructing a `ProgramRegistry`:

```ts
import { ProgramRegistry } from '@simodelne/pgas-server/api';
// [pgas-plugin:program-registry] — auto-injected program imports below

// [pgas-plugin:spec-registry] — auto-injected spec loads below

// [pgas-plugin:handler-registry] — auto-injected handler imports below

const registry = new ProgramRegistry();
// [pgas-plugin:program-registration] — auto-injected `registry.register(...)` calls below
```

After `/pgas-new-program legal-rag`:

```ts
import { ProgramRegistry } from '@simodelne/pgas-server/api';
import { createLegalRagProgramEntry } from '../programs/legal-rag/registration.js';
// [pgas-plugin:program-registry] — auto-injected program imports below

// [pgas-plugin:spec-registry] — auto-injected spec loads below

// [pgas-plugin:handler-registry] — auto-injected handler imports below

const registry = new ProgramRegistry();
registry.register('legal-rag', createLegalRagProgramEntry());
// [pgas-plugin:program-registration] — auto-injected `registry.register(...)` calls below
```

Note what did **not** change: the `spec-registry` and `handler-registry`
markers received no lines (spec-load and handler binding are
encapsulated inside `programs/legal-rag/registration.ts`), and all four
markers remain in the file.

After a second invocation `/pgas-new-program contract-draft`:

```ts
import { ProgramRegistry } from '@simodelne/pgas-server/api';
import { createLegalRagProgramEntry } from '../programs/legal-rag/registration.js';
import { createContractDraftProgramEntry } from '../programs/contract-draft/registration.js';
// [pgas-plugin:program-registry] — auto-injected program imports below

// [pgas-plugin:spec-registry] — auto-injected spec loads below

// [pgas-plugin:handler-registry] — auto-injected handler imports below

const registry = new ProgramRegistry();
registry.register('legal-rag', createLegalRagProgramEntry());
registry.register('contract-draft', createContractDraftProgramEntry());
// [pgas-plugin:program-registration] — auto-injected `registry.register(...)` calls below
```

### The injected lines (exact contract)

For program `<name>` with PascalCase `<Pascal>`:

- Above `// [pgas-plugin:program-registry]`:

  ```ts
  import { create<Pascal>ProgramEntry } from '../programs/<name>/registration.js';
  ```

- Above `// [pgas-plugin:program-registration]`:

  ```ts
  registry.register('<name>', create<Pascal>ProgramEntry());
  ```

- Above `// [pgas-plugin:spec-registry]` and
  `// [pgas-plugin:handler-registry]`: nothing.

The injected import is a **named** import of `create<Pascal>ProgramEntry`,
so `programs/<name>/registration.ts` MUST export that exact
program-specific symbol — either `export function
create<Pascal>ProgramEntry(...)` or `export { createProgramEntry as
create<Pascal>ProgramEntry }`. A generic `createProgramEntry` export with
no program-specific re-export will not satisfy this import.

## Idempotency

The plugin guarantees that re-running `/pgas-new-program <name>` with
the **same name** does NOT duplicate the insertion. Before injecting,
the command checks whether a line already references the program name
(`programs/<name>/registration.js`, `create<Pascal>ProgramEntry`,
`register('<name>', …)`). If present, the command skips the injection at
that site and reports "already-registered".

This makes the command safe to re-run when scaffold templates change
(e.g. plugin v0.3 lands and you want to re-scaffold an existing program
with the new template's tweaks).

## Disabling marker-based injection

A consumer that does NOT want plugin-based injection (e.g. because
they hand-craft their server bootstrap and find the markers offensive)
can simply **delete the marker comments**. With no markers present,
`/pgas-new-program` falls back to the `AskUserQuestion` candidate-file
flow described in `MODE-B-DETECTION.md`.

Deleting one marker but keeping the others is supported — the command
falls back per-marker. (Deleting only the two empty markers,
`spec-registry` / `handler-registry`, has no practical effect under the
registration.ts convention, since the command injects nothing there
anyway.)

## When to update markers

If you rename a marker (e.g. plugin v0.3 introduces
`// [pgas-plugin:adapter-registry]`), bump the plugin major version.
Marker renames break consumer scaffolds that referenced the old name;
treat them as breaking changes.

If you ADD a new marker (e.g. plugin v0.3 introduces
`// [pgas-plugin:health-check]`), bump the plugin minor version.
Adding a marker is backward-compatible — existing consumers that don't
have it simply trigger the AskUserQuestion fallback at that site.
