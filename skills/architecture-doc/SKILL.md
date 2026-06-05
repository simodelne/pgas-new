---
name: pgas:architecture-doc
description: Generate or update audit/ARCHITECTURE-<consumer>-v<MAJOR>.<MINOR>.0.md per the 10-section CONSUMER-VERSIONING-CONTRACT. Run on every minor or major version cut. The doc is the auditable record of what the consumer's program does at this version snapshot, and the diff vs the prior minor's doc is the forcing function that surfaces intent-vs-implementation drift.
---

# pgas:architecture-doc

Generate or update the per-version architecture document a pgas
consumer ships in its own repo on every minor or major version cut.

**Source of truth**: `CONSUMER-VERSIONING-CONTRACT.md` v1.0.0 in
`simodelne/pgas`. The 10 sections below are copied from that
contract verbatim — do not deviate from the structure.

## When to use

- After bumping the consumer's `package.json` version to a new
  major (`vX.0.0`) or minor (`v0.Y.0`).
- Before opening the release PR.
- Per pgas#254, this is currently soft-enforced — the curator notes
  missing docs during PR review (Channel 3). The plugin's
  `post-tool-use-arch-doc-nudge.sh` hook prints a warning when a
  `.0` `npm publish` runs without the matching doc.

**Patch bumps** (`v0.0.Z`) do NOT need a new doc — they reuse the
prior minor's doc. If a patch alters the architecture, it should not
have been a patch.

## Step 1 — gather context

```bash
# Consumer name (used in filename)
CONSUMER=$(jq -r '.name | sub("^@[^/]+/"; "")' package.json)

# Version being cut
VERSION=$(jq -r '.version' package.json)

# Major.minor (the filename stays at MAJOR.MINOR.0 even for patch bumps)
MAJOR_MINOR=$(echo "$VERSION" | awk -F. '{print $1"."$2".0"}')

# Target file
TARGET="audit/ARCHITECTURE-${CONSUMER}-v${MAJOR_MINOR}.md"
```

## Step 2 — find the prior doc (if any)

```bash
PRIOR=$(ls audit/ARCHITECTURE-${CONSUMER}-v*.md 2>/dev/null | sort -V | tail -1)
```

If `$PRIOR` exists and equals `$TARGET`, the doc already exists for
this minor — offer to update it in place rather than overwrite.

If `$PRIOR` exists and differs from `$TARGET`, this is a new minor or
major. The new doc MUST include a "What changed since v<PRIOR>"
preamble that articulates the diff.

## Step 3 — populate the 10 sections

Read these inputs to derive the content:

- `programs/*/spec.yml` (or `specs.yml`) — for sections 2, 3, 5, 7
- `programs/*/handlers/*.ts` — for sections 4, 5
- `programs/*/registration.ts` — for sections 1, 4 (the `createAdapters`
  override + `tool:<name>` channel wiring)
- `server/index.ts` (or equivalent) — for section 1
- `package.json` — for section 9
- `governance/approved_parameters.json` + `EVAL_LEDGER.md` (if present) —
  for section 6 lock binding
- The previous doc (`$PRIOR`) — for diffing into the preamble

**Current spec shape (read it correctly):** the start mode is the
top-level `initial: <mode>` (terminal modes are `terminal: [<mode>, …]`).
Transitions are declared PER MODE under `modes.<name>.transitions:` as an
array of `{ guard: { kind, path, value? }, target, crystallize? }`; there
is NO top-level `transitions:` block. Action → mode routing is the
top-level `proceed_to:` map (action name → target mode). Inbound-channel
ingestion paths live under top-level `ingestion:` (NOT `channel_paths:`).
Read the mode graph from these, not from any legacy top-level block.

### Section template

```markdown
# ARCHITECTURE — ${CONSUMER} v${MAJOR_MINOR}

**Status:** Cut on YYYY-MM-DD against `@simodelne/pgas-runtime@vX.Y.Z`
(see § 9).
**Companion contract:** [`simodelne/pgas`/CONSUMER-VERSIONING-CONTRACT.md](https://github.com/simodelne/pgas/blob/main/CONSUMER-VERSIONING-CONTRACT.md)

## What changed since v<PRIOR>

<bullet diff vs the prior minor — what shifted, why, what assumptions
no longer hold. THIS IS THE FORCING FUNCTION per CONSUMER-VERSIONING-CONTRACT
§ 6. If this is the first architecture doc for this consumer, write
"Initial cut — no prior version.">

---

## 1. Layer diagram

Consumer caller → pgas-server → engine → program handlers → external services.
The full request/response path, end to end. ASCII or mermaid; whichever
is more readable.

## 2. Mode graph

Every nonterminal mode plus every transition guard. The complete state
machine the program implements. Diagram + table — name, transitions
out, guard expressions. Build it from each mode's
`modes.<name>.transitions[]` (`target` + `guard.{kind,path,value}`) plus
the top-level `proceed_to:` action-routing map; the start node is
`initial:` and sinks are `terminal:`. There is no top-level
`transitions:` block to read.

## 3. Per-mode action table

For each mode: legal actions (its `vocabulary:`), what they write (paths
+ types, from `action_map`), and the transition condition that exits the
mode (the mode's own `transitions[].guard`).

| Mode | Action | Writes | Exit guard |
|------|--------|--------|------------|
| ...  | ...    | ...    | ...        |

## 4. Tools catalog

Every spec-declared action and tool with required args, result paths,
and a file:line reference to the handler implementation.

| Tool | Args | Result path | Handler file:line |
|------|------|-------------|-------------------|
| ...  | ...  | ...         | programs/.../handlers/index.ts:123 |

## 5. Gates and checkers

The pre-completion validation chain: which gates run when, what each
rejects, what each lets through.

## 6. Parameters

Split into "governance-locked" (with citations to the lockfile / paper
evidence) and "agent-decidable" (with the legal range).

| Parameter | Lock status | Value | Evidence / range |
|-----------|-------------|-------|------------------|
| ...       | locked      | 0.7   | governance/approved_parameters.json:42 + EVAL_LEDGER.md#24 |
| ...       | decidable   | -     | range: [1, 50]    |

## 7. Schema highlights

Engine-owned paths (the `inputs.query_meta.*` set declared per pgas#253
FM5), flat-domain key conventions, any program-domain prefixes the
program reserves.

## 8. Failure modes and salvage path

Known failure shapes the program recovers from, plus what the recovery
looks like to an observer.

## 9. Versioning context

| Dep | Range | Lockfile-resolved |
|-----|-------|-------------------|
| @simodelne/pgas-runtime | ^1.8.0 | 1.8.1 |
| @simodelne/pgas-server  | ^1.8.0 | 1.8.1 |
| ...     | ...    | ...    |

Corpus version (if applicable): `<from corpus/manifest.yml>`

## 10. References

File:line pointers for every claim in this doc. An auditor following
references reaches the source code that backs each statement.
```

## Step 4 — write the doc

Write to `audit/ARCHITECTURE-${CONSUMER}-v${MAJOR_MINOR}.md`.

If `$PRIOR` exists and is different, ALSO open a tiny diff explaining
**what changed since v<PRIOR>** at the top of the new doc. The diff is
the forcing function that surfaces intent-vs-implementation drift
(per pgas#254 § 6, pgas-rag FM3 worked example).

## Step 5 — verify

Run these self-checks:

1. Every numbered section heading from 1-10 is present.
2. Every `file:line` reference in the doc points at a file that
   currently exists in the working tree.
3. The dep table in § 9 matches the consumer's `package.json` +
   `package-lock.json` (or `pnpm-lock.yaml`).
4. The mode graph in § 2 mentions every mode named in spec.yml.
5. The tools catalog in § 4 mentions every entry in spec.yml's
   `tools:` block.

Report any inconsistencies to the user; do not silently paper over
them. The doc's value depends on its accuracy.

## Step 6 — print next steps

```
✓ Wrote audit/ARCHITECTURE-${CONSUMER}-v${MAJOR_MINOR}.md (<N> lines, <K> sections)
✓ Diffed against <prior file> — <M> material changes summarized in preamble

Next steps:
  1. Commit the doc with the version-bump PR.
  2. Link the doc in the release notes (per CONSUMER-VERSIONING-CONTRACT
     pre-publish checklist).
  3. If this consumer uses governance-locked parameters, verify
     section 6 cites every entry in governance/approved_parameters.json.
```

## Notes

- **No CI gate yet.** Per CONSUMER-VERSIONING-CONTRACT v1.0.0 § 5, this
  contract is soft + medium enforcement only. The hard tier (CI gate
  blocking `npm publish`) is out of scope for v1.
- **First doc per consumer is special.** The "What changed since
  v<PRIOR>" preamble simply says "Initial cut — no prior version." No
  diff is required.
- **The doc is auditable, not exhaustive.** Don't write a 600-line
  doc when 200 suffice. The forcing function is the diff against the
  prior version, not absolute size.
