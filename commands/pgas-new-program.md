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

**Zero-friction default.** If the user skips the optional design
interview (Step 0), this command scaffolds the minimal three-mode
program (`start → working → complete`) and wires it in — no questions
beyond name/slug. The interview only *customizes* that skeleton; it is
never required to get a working program.

## Step 0 — (optional) design interview

Before scaffolding, **offer** a short design interview adapted from the
`pgas-program-builder` skill's methodology. It is opt-in: ask once
whether the user wants to design the mode graph now or take the default
3-mode skeleton.

Open with a single `AskUserQuestion`:

> "Want to design the program's mode graph now (≈6 quick questions), or
> scaffold the default `start → working → complete` skeleton and shape
> it yourself later? (design / default)"

If the user answers **default** (or skips), go straight to Step 1 — the
scaffold emits the minimal three-mode program unchanged. **Do not block
on the interview.**

If the user answers **design**, ask the following six questions (batch
them via `AskUserQuestion`; accept "skip" on any one and fall back to
the default for that dimension):

- **Q1 — Purpose.** "In one sentence, what does this program do?"
  → feeds the spec `preamble` ROLE line and the `manifest.description`.
- **Q2 — Entry channel.** "How does work arrive? (e.g. a user message,
  a scheduled tick, a webhook, another program delegating to it)"
  → feeds the bootstrap mode's input channel + `continuationPolicy`
  defaults. Default: `user_text`.
- **Q3 — Stages of work.** "What are the distinct stages this work
  moves through? Name them in order." → these become the **mode
  names**. Default if skipped: `start`, `working`, `complete`.
- **Q4 — Decision points.** "Are there points where the flow branches
  (e.g. needs approval, can loop back, can bail out)?" → these become
  **extra `transitions`** entries (additional `from/to/trigger` rows,
  optionally with a `guard`).
- **Q5 — Delegation.** "Does any stage delegate to a child session /
  another program?" → if yes, note it for the architecture doc and (if
  the installed engine exposes a delegation surface) a `delegationPolicy`
  TODO; do NOT invent engine APIs that aren't installed.
- **Q6 — Completion criteria.** "How do you know the program is done?"
  → feeds the **terminal mode** + the **guard** on the transition into
  it (the `work.*_ready` gate pattern).

### How the answers parameterize the scaffold

The answers customize the **emitted** `spec.yml`; they do not trigger a
freeform rewrite. The customization is mechanical:

1. **Mode renames (Q3).** Replace the generic `start` / `working` /
   `complete` mode names with the user's stage names throughout
   `spec.yml` — `mode_initial`, the `modes:` keys, the `transitions:`
   `from`/`to` values, and the `preamble` WORKFLOW line. Keep the
   **first** stage as the bootstrap mode (the only one that admits
   `system_mode_entry`, per FM3) and the **last** as the terminal mode.
2. **Extra working stages (Q3, >3 stages).** For each stage between the
   bootstrap and terminal modes, **copy the `working` mode block**
   (its channels, prompts, vocabulary shape) and rename it. Do NOT
   hand-author a novel mode shape — the `working` block already has the
   FM3-safe channel set (no `system_mode_entry`). Chain them with
   linear `transitions`.
3. **Extra transitions (Q4).** Add `from/to/trigger` rows for each
   branch / loop-back / bail-out the user named. Put a `guard` on any
   transition that should only fire once a domain flag is set (mirror
   the `working → complete` guard `work.example_ready`).
4. **Terminal + gate (Q6).** Name the terminal mode after the user's
   final stage and gate the transition into it on the completion flag.
5. **Prose only (Q1, Q2, Q5).** Fold the purpose into the `preamble`
   ROLE line and `manifest.description`; note the entry channel and any
   delegation in the README and `audit/ARCHITECTURE.md` TODO.

After the interview, **echo the resulting mode list and transition list
back to the user for confirmation** before copying templates. Then
proceed to Step 1 and apply these renames/copies during the Step 4
substitution pass.

> If the user took the **default** path, skip all of the above — the
> template ships the 3-mode skeleton as-is.

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
   contexts (the `registry.register('<name>', …)` literal still uses
   the kebab name).

Also derive **`{{PROGRAM_NAME_PASCAL}}`** from the program name:
strip the hyphens and upper-case each segment's first letter
(`legal-rag` → `LegalRag`, `contract-draft` → `ContractDraft`). This
drives the injected import/registration identifiers in Step 6.

## Step 3 — detect insertion sites

Per the plugin's locked decision (#3), insertion uses **marker comments
first, AskUserQuestion fallback second**.

### 3.1 Search for markers

Search `server/` and `src/` for these exact marker comments:

```
// [pgas-plugin:program-registry] — auto-injected program imports below
// [pgas-plugin:program-registration] — auto-injected `registry.register(...)` calls below
// [pgas-plugin:spec-registry] — auto-injected spec loads below
// [pgas-plugin:handler-registry] — auto-injected handler imports below
```

Use the Grep tool with `pattern: '// \\[pgas-plugin:(program-registry|program-registration|spec-registry|handler-registry)\\]'` and `output_mode: 'files_with_matches'`.

For each marker found, the insertion is **above** the marker line.

**Which markers receive content (registration.ts convention).** The
scaffolded program ships a `programs/<name>/registration.ts` that
encapsulates spec-loading and handler-binding behind a single
`createProgramEntry()` factory. Because of that, only **two** of the
four markers receive injected content:

| Marker | Receives content? | Why |
|--------|-------------------|-----|
| `program-registry` | **YES** — one `import` line | imports the program's `create<Pascal>ProgramEntry` factory |
| `program-registration` | **YES** — one `registry.register(...)` line | registers the program entry |
| `spec-registry` | **NO** — stays empty | spec-loading is encapsulated inside `registration.ts` |
| `handler-registry` | **NO** — stays empty | handler imports are encapsulated inside `registration.ts` |

The two empty markers **MUST remain in the file** — never remove them.
They exist for backward compatibility and for consumers that wire their
programs inline (loading the spec and importing handlers directly in
`server/index.ts` instead of through a `registration.ts` shim). See
`docs/MARKER-PROTOCOL.md` for the full contract.

### 3.2 Fallback when markers are absent

If a marker is not found, run candidate-file detection per
`docs/MODE-B-DETECTION.md`:

1. Files importing `@simodelne/pgas-server/api` rank first.
2. Files containing `ProgramRegistry`, `createProgramAdapters`, or
   `loadSpecWithPatterns` rank next.
3. Files containing handler maps (`handlers = {`, `const handlers:` —
   any object literal of named functions) rank last.

Show the top 3 candidates to the user via `AskUserQuestion`:

> "Marker comment `// [pgas-plugin:program-registry]` not found in
> server/. Where should program `<PROGRAM_NAME>` be wired?
> Pick a file: (1) server/index.ts (constructs the ProgramRegistry)
> (2) server/registrations.ts (calls registry.register) (3)
> src/bootstrap.ts (has handlers map)"

Then a follow-up `AskUserQuestion` asks for the line range:

> "In `<selected file>`, where should the registration go? Show me
> line ranges containing existing program registrations or the
> ProgramRegistry construction, then I'll insert the import near the
> other imports and the `registry.register(...)` call near the other
> registrations."

Use the user's answer to compute insertion line numbers. Inject the
same two lines (import + register) you would inject above the markers.

## Step 4 — copy templates/new-program/ to programs/<PROGRAM_NAME>/

Detect the consumer's existing program directory layout:

- If `programs/` exists, copy under `programs/<PROGRAM_NAME>/`.
- Else if `src/programs/` exists, copy under `src/programs/<PROGRAM_NAME>/`.
- Else create `programs/<PROGRAM_NAME>/`.

Copy the **entire** `templates/new-program/` tree. The current scaffold
tree is:

```
programs/<PROGRAM_NAME>/
├── spec.yml                         ← declarative mode graph + schema (FM3+FM5 closed)
├── registration.ts                  ← wiring shim: loadSpec + bind handlers → ProgramEntry
├── prompts/
│   ├── system.md                    ← cross-cutting system prompt
│   └── action-descriptions.md       ← per-action descriptions
├── handlers/
│   ├── _resolver.ts                 ← FM1 domain-fallback resolver
│   └── index.ts                     ← handler registry
├── tests/
│   ├── spec-load.test.ts            ← asserts spec.yml loads (loadSpec smoke)
│   └── registration.test.ts         ← asserts createProgramEntry() returns a valid entry
├── audit/
│   └── ARCHITECTURE.md              ← per-program architecture doc
└── README.md
```

> **`registration.ts` and the `tests/` pair land via sibling PRs** in
> the same v0.3 cut. They are part of the scaffold tree the copy step
> picks up automatically (the copy is whole-tree, not file-enumerated),
> so no special handling is needed here — but the report (Step 8) and
> the verification (Step 7) reference them.

Substitute placeholders in every `.tmpl` file:

- `{{PROGRAM_NAME}}` → kebab-case program name
- `{{PROGRAM_SLUG}}` → underscore slug
- `{{PROGRAM_NAME_PASCAL}}` → PascalCase (`legal-rag` → `LegalRag`)
- `{{CONSUMER_NAME}}` → name from the consumer's `package.json`
- `{{ENGINE_VERSION}}` → resolved from the consumer's `package.json`
  `dependencies['@simodelne/pgas-runtime']`

Drop the `.tmpl` extension when writing.

If the user did the **design interview** (Step 0), apply the mode
renames / extra working-mode copies / extra transitions to the rendered
`spec.yml` during this pass (mechanical edits per Step 0, not a
freeform rewrite). The **default** path renders the template unchanged.

## Step 5 — build the combined patch + diff-and-confirm

Per the plugin's locked decision (#3), always diff-and-confirm before
applying.

Build a single patch covering:

1. The new files copied from `templates/new-program/`.
2. The two insertions: the `import` above the `program-registry` marker
   and the `registry.register(...)` above the `program-registration`
   marker (or, in fallback mode, at the user-chosen sites). The
   `spec-registry` and `handler-registry` markers are left untouched.

Show the entire patch as a unified diff to the user. Then ask:

> "Apply this patch? (yes/no)"

**Only proceed if the user replies "yes" (or "apply").** A "no" reply
aborts cleanly — leave the working tree untouched.

## Step 6 — apply

For each new file, write it. For the two insertion sites, read the file,
splice in the new line above the marker (or at the user-chosen line),
write the file back.

The exact injection contract (registration.ts convention):

- Above `// [pgas-plugin:program-registry]`, inject:

  ```ts
  import { create<PROGRAM_NAME_PASCAL>ProgramEntry } from '../programs/<PROGRAM_NAME>/registration.js';
  ```

  (e.g. for `legal-rag`:
  `import { createLegalRagProgramEntry } from '../programs/legal-rag/registration.js';`)

- Above `// [pgas-plugin:program-registration]`, inject:

  ```ts
  registry.register('<PROGRAM_NAME>', create<PROGRAM_NAME_PASCAL>ProgramEntry());
  ```

  (e.g.
  `registry.register('legal-rag', createLegalRagProgramEntry());`)

- `// [pgas-plugin:spec-registry]` and `// [pgas-plugin:handler-registry]`
  get **no injection** — the program's `registration.ts` owns spec
  loading and handler binding. Leave both markers in place.

> **Export-name contract.** The injected import is a *named* import of
> `create<PROGRAM_NAME_PASCAL>ProgramEntry`, so the scaffolded
> `programs/<PROGRAM_NAME>/registration.ts` MUST export a symbol with
> that exact program-specific name (e.g. `export function
> createLegalRagProgramEntry(...)`, or
> `export { createProgramEntry as createLegalRagProgramEntry }`). The
> `registration.ts.tmpl` ships from a sibling PR; the PascalCase export
> name is what makes the injected import resolve. If you wire inline
> instead (no `registration.ts`), import from your own factory under the
> same name or adjust the import accordingly.

The marker protocol guarantees **idempotency**: re-running the command
with the **same name** does NOT duplicate insertions, because each
injected line contains the program's name (`programs/<name>/registration.js`,
`create<Pascal>ProgramEntry`, `register('<name>', …)`). Before injecting,
check whether a line already references the program name at that site;
if it does, skip and report "already-registered". See
`docs/MARKER-PROTOCOL.md`.

## Step 7 — run validation (and gate it loudly)

After applying, verify the scaffold. Run, in order:

1. `pgas:spec-validate` against `programs/<PROGRAM_NAME>/spec.yml`.
2. `pgas:mode-entry-lint` against the same file.
3. **If the consumer has `node_modules/` installed** (check
   `[[ -d node_modules ]]`), also run the scaffolded program's own
   spec-load test so verification exercises the real installed engine,
   not just the static linters:

   ```bash
   # Run just this program's tests if the consumer's runner can target
   # a path filter (vitest/jest both accept a path substring):
   npm test -- programs/<PROGRAM_NAME> 2>&1 | tail -40 \
     || echo "NOTE: program-scoped test run failed or the runner does not accept a path filter; run 'npm test' manually."
   ```

   If `node_modules/` is absent, skip step 3 and say so explicitly —
   tell the user to `npm install` then re-run verification. A skipped
   step is **not** a pass.

Then print a loud verification block. Compute PASS only if
`spec-validate` AND `mode-entry-lint` pass AND (the spec-load test
passed OR was legitimately skipped for missing `node_modules`):

```
══════════════════════════════════════════════════════════
  SCAFFOLD VERIFICATION: <PASS | FAIL>
══════════════════════════════════════════════════════════
  spec-validate    : <pass/fail>
  mode-entry-lint  : <pass/fail>
  spec-load test   : <pass/fail/skipped (no node_modules)>
══════════════════════════════════════════════════════════
```

**Do not hard-abort on FAIL** — the working tree stays as-is. But on
**FAIL**, instruct the user explicitly:

> "Verification FAILED. Fix the spec.yml / registration.ts issue
> reported above **before** writing handler logic or prompts — a broken
> spec will not load, so handler work would be built on sand. The
> failure is usually informative: e.g. the consumer's installed
> `@simodelne/pgas-runtime` version doesn't yet support a key the
> template uses, in which case file an issue on `simodelne/pgas`
> (Channel 4) rather than hacking the template."

On **PASS**, proceed to Step 8.

## Step 8 — print next steps

```
✓ Created program ${PROGRAM_NAME} under programs/${PROGRAM_NAME}/
    spec.yml · registration.ts · prompts/ · handlers/ · tests/ · audit/ · README.md
✓ Registered in:
    - <file>:<line> (program-registry — import create${PROGRAM_NAME_PASCAL}ProgramEntry)
    - <file>:<line> (program-registration — registry.register('${PROGRAM_NAME}', …))
    (spec-registry / handler-registry markers left intentionally empty —
     registration.ts owns spec-load + handler binding)
✓ SCAFFOLD VERIFICATION: <PASS/FAIL>  (see Step 7 block above)

Next steps:
  1. Write the actual prompts in
     programs/${PROGRAM_NAME}/prompts/system.md
     and prompts/action-descriptions.md.
  2. Implement the handlers in programs/${PROGRAM_NAME}/handlers/index.ts.
     The skeleton calls _resolver.ts to read flat-key domain — see
     FM1 in pgas#253 for why. registration.ts already binds them.
  3. Run the program's own tests:
       npm test            # in the consumer root
     This runs programs/${PROGRAM_NAME}/tests/spec-load.test.ts and
     registration.test.ts — they assert the spec loads and
     create${PROGRAM_NAME_PASCAL}ProgramEntry() returns a valid entry.
  4. Write the architecture doc at
     programs/${PROGRAM_NAME}/audit/ARCHITECTURE.md
     using /pgas:architecture-doc skill (10-section contract per pgas#254).
  5. When you cut a v0.X.0 release of the consumer, include the
     program's contribution in the consumer-level architecture doc
     audit/ARCHITECTURE-${CONSUMER_NAME}-v0.X.0.md.
```

## Step 9 — verify it actually runs

The scaffold is **wired and typecheck-clean by construction**, but
wiring is not the same as a live session. After you implement the
handlers and prompts (Step 8 items 1–2), confirm the program actually
boots and registers:

1. **Boot the consumer's server** and watch the startup logs. The
   `ProgramRegistry` is populated at boot; a successfully-registered
   program appears in the registry. Confirm `${PROGRAM_NAME}` is listed
   (e.g. via the registry's `list()` surface or the server's
   program-listing log line) — that proves the import + `registry.register`
   from Step 6 took effect.

   ```bash
   npm run dev    # or the consumer's documented server-start script
   # → look for ${PROGRAM_NAME} in the boot logs / registered-programs list
   ```

2. **Re-run the program's tests** any time you change the spec or
   registration:

   ```bash
   npm test       # runs the per-program spec-load + registration tests
   ```

**Honesty about coverage.** As of plugin v0.3, the plugin verifies
**load + typecheck**: the `spec-load` / `registration` tests assert the
spec parses and `createProgramEntry()` returns a valid entry, and the
plugin's `server-typecheck` gate proves the wired server typechecks
against the real installed engine. The plugin does **not yet** drive a
live LLM session end-to-end — a live-session smoke gate is planned but
not shipped. So "registers + typechecks + spec loads" is what's
mechanically guaranteed today; the first real session is still on you to
run. The plugin's spec-load gate (`pgas:spec-validate` + the scaffolded
`spec-load.test.ts`) is the load-correctness backstop in the meantime.

## Notes

- **Marker protocol** — see `docs/MARKER-PROTOCOL.md` for the exact
  regex, the registration.ts injection contract (two markers injected,
  two intentionally empty), idempotency rules, and how to disable
  marker-based injection.
- **Mode B detection** — see `docs/MODE-B-DETECTION.md` for the
  candidate-file ranking algorithm.
- **Design methodology** — Step 0's interview is adapted from the
  `pgas-program-builder` skill (modes / transitions / actions /
  reactions / guards). Reach for that skill when a program's graph is
  non-trivial.
- **Classifier-denial rule (governance I-6).** If the harness denies a
  tool call, STOP. Do not retry with `dangerouslyDisableSandbox: true`
  or any equivalent bypass. Surface what was attempted, why it seems
  needed, and a smaller alternative. Escalation, not bypass.
