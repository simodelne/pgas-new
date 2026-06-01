# Marker protocol

The plugin's `/pgas-new-program` command injects new program
registration into the consumer's existing `server/index.ts` (or
equivalent). To avoid having to re-implement file-shape detection for
every consumer, the scaffold places **marker comments** at the
canonical injection sites.

## The three markers

```
// [pgas-plugin:program-registry] — auto-injected program imports below
// [pgas-plugin:spec-registry] — auto-injected spec loads below
// [pgas-plugin:handler-registry] — auto-injected handler imports below
```

Plus a fourth for the actual `registry.register(...)` calls:

```
// [pgas-plugin:program-registration] — auto-injected `registry.register(...)` calls below
```

All four are placed in the scaffolded `templates/new-consumer/server/index.ts.tmpl`.

## The recognizing regex

`/pgas-new-program` uses this exact pattern (anchored to the start of
the comment to avoid accidental matches inside strings):

```regex
^\s*// \[pgas-plugin:(program-registry|spec-registry|handler-registry|program-registration)\]
```

## Where new content is inserted

**Above** the marker line. The marker stays put — only new lines are
added between the existing code above and the marker.

Example before:

```ts
import { ProgramRegistry } from '@simodelne/pgas-server';
// [pgas-plugin:program-registry] — auto-injected program imports below
```

Example after `/pgas-new-program legal-rag`:

```ts
import { ProgramRegistry } from '@simodelne/pgas-server';
import { createLegalRagProgramEntry } from '../programs/legal-rag/registration.js';
// [pgas-plugin:program-registry] — auto-injected program imports below
```

After a second invocation `/pgas-new-program contract-draft`:

```ts
import { ProgramRegistry } from '@simodelne/pgas-server';
import { createLegalRagProgramEntry } from '../programs/legal-rag/registration.js';
import { createContractDraftProgramEntry } from '../programs/contract-draft/registration.js';
// [pgas-plugin:program-registry] — auto-injected program imports below
```

## Idempotency

The plugin guarantees that re-running `/pgas-new-program <name>` with
the **same name** does NOT duplicate the insertion. Before injecting,
the command checks whether a line already references the program name
(`programs/<name>/`, `create<PascalName>ProgramEntry`, etc.). If
present, the command skips the injection at that site and reports
"already-registered".

This makes the command safe to re-run when scaffold templates change
(e.g. plugin v0.2 lands and you want to re-scaffold an existing
program with the new template's tweaks).

## Disabling marker-based injection

A consumer that does NOT want plugin-based injection (e.g. because
they hand-craft their server bootstrap and find the markers offensive)
can simply **delete the marker comments**. With no markers present,
`/pgas-new-program` falls back to the `AskUserQuestion` candidate-file
flow described in `MODE-B-DETECTION.md`.

Deleting one marker but keeping the others is supported — the command
falls back per-marker.

## When to update markers

If you rename a marker (e.g. plugin v0.2 introduces
`// [pgas-plugin:adapter-registry]`), bump the plugin major version.
Marker renames break consumer scaffolds that referenced the old name;
treat them as breaking changes.

If you ADD a new marker (e.g. plugin v0.2 introduces
`// [pgas-plugin:health-check]`), bump the plugin minor version.
Adding a marker is backward-compatible — existing consumers that don't
have it simply trigger the AskUserQuestion fallback at that site.
