---
description: Scaffold a new program inside an existing pgas consumer (Mode B)
allowed-tools: Bash, Read, Write, Edit, AskUserQuestion, Grep, Glob
---

# /pgas-new-program — scaffold a new program in the current consumer

This command scaffolds a **new pgas program inside an existing
consumer** ("Mode B"). Per the plugin's locked architectural decisions
Mode B is the first-class case: even Mode A (`/pgas-new-consumer`)
invokes this command internally for its bootstrap program.

The scaffolded program closes the relevant pgas#253 failure modes by
construction:

- **FM1**: program ships with `handlers/_resolver.ts` — the
  domain-fallback resolver pattern.
- **FM3**: spec.yml admits `system_mode_entry` ONLY on the bootstrap
  mode (`start`), NOT on handler-result-driven modes.
- **FM5**: spec.yml schema includes the engine-owned
  `inputs.query_meta.*` paths (or TODO with explicit list if the engine
  doesn't yet export `engineOwnedContinuationPaths`).

## Step 1 — detect we're inside a pgas consumer

Check the current working directory for a `package.json` that depends on
any `@simodelne/pgas-*` package:

```bash
if [[ ! -f package.json ]]; then
  echo "ERROR: not in a pgas consumer (no package.json in CWD)" >&2
  exit 1
fi

if ! grep -q '"@simodelne/pgas-' package.json; then
  echo "ERROR: not in a pgas consumer (no @simodelne/pgas-* deps in package.json)" >&2
  echo "       Run /pgas-new-consumer first to scaffold a consumer." >&2
  exit 1
fi
```

If the check fails, abort with a clear "Run `/pgas-new-consumer` first."

## Step 2 — gather inputs

Ask the user via `AskUserQuestion`:

1. **Program name** — kebab-case, e.g. `legal-rag`, `contract-draft`.
   Used as the directory name under `programs/`.
2. **Program slug** — default = program name with `_` instead of `-`
   (e.g. `legal-rag` → `legal_rag`). Used in TypeScript identifier
   contexts (`createLegalRagProgramEntry`, etc.).

## Step 3 — detect insertion sites

Per the plugin's locked decision (#3), insertion uses **marker comments
first, AskUserQuestion fallback second**.

### 3.1 Search for markers

Search `server/` and `src/` for these exact marker comments:

```
// [pgas-plugin:program-registry] — auto-injected program imports below
// [pgas-plugin:spec-registry] — auto-injected spec loads below
// [pgas-plugin:handler-registry] — auto-injected handler imports below
```

Use the Grep tool with `pattern: '// \\[pgas-plugin:(program-registry|spec-registry|handler-registry)\\]'` and `output_mode: 'files_with_matches'`.

For each marker found, the insertion is **above** the marker line.

### 3.2 Fallback when markers are absent

If a marker is not found, run candidate-file detection per
`docs/MODE-B-DETECTION.md`:

1. Files importing `@simodelne/pgas-server` rank first.
2. Files containing `createDeclarativeSession` or `loadSpec` rank next.
3. Files containing handler maps (`handlers = {`, `const handlers:` —
   any object literal of named functions) rank last.

Show the top 3 candidates to the user via `AskUserQuestion`:

> "Marker comment `// [pgas-plugin:program-registry]` not found in
> server/. Where should program `<PROGRAM_NAME>` be wired?
> Pick a file: (1) server/index.ts (imports @simodelne/pgas-server)
> (2) server/programs.ts (calls loadSpec) (3) src/bootstrap.ts (has
> handlers map)"

Then a follow-up `AskUserQuestion` asks for the line range:

> "In `<selected file>`, where should the registration go? Show me
> line ranges containing existing program registrations or handler
> maps, then I'll insert just before the closing brace."

Use the user's answer to compute insertion line numbers.

## Step 4 — copy templates/new-program/ to programs/<PROGRAM_NAME>/

Detect the consumer's existing program directory layout:

- If `programs/` exists, copy under `programs/<PROGRAM_NAME>/`.
- Else if `src/programs/` exists, copy under `src/programs/<PROGRAM_NAME>/`.
- Else create `programs/<PROGRAM_NAME>/`.

Substitute placeholders in every `.tmpl` file:

- `{{PROGRAM_NAME}}` → kebab-case program name
- `{{PROGRAM_SLUG}}` → underscore slug
- `{{PROGRAM_NAME_PASCAL}}` → PascalCase (`legal-rag` → `LegalRag`)
- `{{CONSUMER_NAME}}` → name from the consumer's `package.json`
- `{{ENGINE_VERSION}}` → resolved from the consumer's `package.json`
  `dependencies['@simodelne/pgas-runtime']`

Drop the `.tmpl` extension when writing.

## Step 5 — build the combined patch + diff-and-confirm

Per the plugin's locked decision (#3), always diff-and-confirm before
applying.

Build a single patch covering:

1. The new files copied from `templates/new-program/`.
2. The insertions above markers (or at user-chosen sites).

Show the entire patch as a unified diff to the user. Then ask:

> "Apply this patch? (yes/no)"

**Only proceed if the user replies "yes" (or "apply").** A "no" reply
aborts cleanly — leave the working tree untouched.

## Step 6 — apply

For each new file, write it. For each insertion site, read the file,
splice in the new lines above the marker (or at the user-chosen line),
write the file back. The plugin's marker protocol guarantees
idempotency: re-running the command **does not duplicate** insertions
because the inserted lines themselves contain the new program's name,
which the next run detects and skips.

## Step 7 — run validation

After applying, run two skill invocations on the new program's spec:

1. `pgas:spec-validate` against `programs/<PROGRAM_NAME>/spec.yml`
2. `pgas:mode-entry-lint` against the same file

Report both results to the user. If either fails, do NOT abort —
report the failure so the user can debug. The scaffold is correct
by construction; a failure here is informative (e.g. the consumer's
installed `@simodelne/pgas-runtime` version doesn't yet support a key
the template uses).

## Step 8 — print next steps

```
✓ Created program ${PROGRAM_NAME} under programs/${PROGRAM_NAME}/
✓ Registered in:
    - <file>:<line> (program-registry)
    - <file>:<line> (spec-registry)
    - <file>:<line> (handler-registry)
✓ spec-validate: <pass/fail>
✓ mode-entry-lint: <pass/fail>

Next steps:
  1. Write the actual prompts in
     programs/${PROGRAM_NAME}/prompts/system.md
     and prompts/action-descriptions.md.
  2. Implement the handlers in programs/${PROGRAM_NAME}/handlers/index.ts.
     The skeleton calls _resolver.ts to read flat-key domain — see
     FM1 in pgas#253 for why.
  3. Write the architecture doc at
     programs/${PROGRAM_NAME}/audit/ARCHITECTURE.md
     using /pgas:architecture-doc skill (10-section contract per pgas#254).
  4. Run npm test to verify the skeleton compiles.
  5. When you cut a v0.X.0 release of the consumer, include the
     program's contribution in the consumer-level architecture doc
     audit/ARCHITECTURE-${CONSUMER_NAME}-v0.X.0.md.
```

## Notes

- **Marker protocol** — see `docs/MARKER-PROTOCOL.md` for the exact
  regex, idempotency rules, and how to disable marker-based injection.
- **Mode B detection** — see `docs/MODE-B-DETECTION.md` for the
  candidate-file ranking algorithm.
- **Classifier-denial rule (governance I-6).** If the harness denies a
  tool call, STOP. Do not bypass.
