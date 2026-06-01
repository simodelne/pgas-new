---
name: pgas:mode-entry-lint
description: Lint a spec.yml for the FM3 system_mode_entry breadth foot-gun documented in pgas#253. Classifies each mode admitting system_mode_entry as bootstrap (safe) vs handler-result-driven (unsafe under v1.8.x) and reports the unsafe ones. Run on every spec.yml change and at every pgas v1.2.x → v1.8.x bump.
---

# pgas:mode-entry-lint

Lint a `spec.yml` for the **FM3** failure mode documented in
[pgas#253](https://github.com/simodelne/pgas/issues/253): a
`system_mode_entry` admission that was correct under `^1.2.x` but
becomes a duplicate-continuation foot-gun under `^1.8.x` if the mode
is also handler-result-driven.

## Background — why this matters

Under `^1.2.x`, every nonterminal mode admitted `system_mode_entry`
to give widget notices a second round to re-evaluate post-mutation
guards (pgas issue #98).

Under `^1.8.x`, `ModeEntryContinuation` AND sync-out replay both feed
into the target mode. If a mode is **handler-result-driven** (a
handler populates state for it AND it admits `system_mode_entry`), the
two paths overlap and generate **duplicate continuations** on every
mode transition. Queue depth rises 1→7 across modes, session exceeds
the 10-minute proof timeout, eventually drains 50 minutes of stale
continuations before lock exhaustion.

The fix (codex commit `eb27ac9`): narrow `system_mode_entry` to
**genuine bootstrap modes only** — modes whose entry is NOT preceded
by a handler write to one of the paths the mode reads.

## Step 1 — parse the spec

```bash
SPEC="${1:-programs/*/spec.yml}"
test -f "$SPEC" || { echo "spec.yml not found at $SPEC" >&2; exit 1; }

# Extract every mode and its channels: line
yq '.modes | to_entries[] | {mode: .key, channels: .value.channels}' "$SPEC"
```

Use `yq` or a Node-based parser (`js-yaml`) — both are acceptable.

## Step 2 — for each mode, classify

For each mode in the spec:

### 2a. Does the mode admit `system_mode_entry`?

Check the mode's `channels:` block:

```yaml
modes:
  retrieve:
    channels: [system_query_result, system_mode_entry, widget_output, tool_call]
```

If `system_mode_entry` is NOT present, the mode is safe — skip.

### 2b. Is the mode bootstrap or handler-result-driven?

Classification rule:

- **Bootstrap** = no other mode transitions INTO this mode AS A RESULT
  OF a handler write to a path the mode reads. Bootstrap modes are
  entered from external triggers (user input, mode-graph start) or
  from a salvage path.
  - Heuristic: the mode appears as the **starting** mode in spec.yml
    (`mode_initial: <name>`), OR every transition `from` clause
    targeting this mode is a salvage / fallback transition (look for
    `salvage` in the source mode name or in a guard expression).

- **Handler-result-driven** = at least one handler writes to a path
  the mode's prompts or guards read.
  - Heuristic: look at the mode's transition guards. If a guard
    references `work.*` or `decisions.*` or `summary.*` AND a
    handler in `handlers/` writes to that same path, the mode is
    handler-result-driven.

### 2c. Classify

| Bootstrap? | Handler-result-driven? | Verdict |
|------------|------------------------|---------|
| yes        | no                     | SAFE — `system_mode_entry` is fine here |
| yes        | yes                    | WARN — bootstrap mode with handler results; review carefully |
| no         | yes                    | **FAIL** — FM3 foot-gun; narrow the admission |
| no         | no                     | INFO — uncommon shape; no FM3 risk but verify intent |

## Step 3 — report

```
pgas:mode-entry-lint — $SPEC
  total modes: <N>
  modes admitting system_mode_entry: <K>

  SAFE (bootstrap, no handler results):
    - plan
    - describe
    - salvage

  FAIL (handler-result-driven, FM3 foot-gun):
    - retrieve   (handler `submit_retrieve` writes work.candidates which mode reads)
    - generate   (handler `submit_generate` writes work.answer which mode reads)
    - verify     (handler `verify_answer` writes decisions.verification which mode reads)

  Recommendation: per pgas#253 FM3 worked example, remove
  `system_mode_entry` from the channels: list of every FAIL mode.
  See codex commit eb27ac9 in pgas-rag for the canonical fix.
```

Exit 0 if no FAIL, 1 if any FAIL.

## Step 4 — worked example (pgas-rag)

The canonical correct shape after the fix (pgas-rag specs.yml):

```yaml
modes:
  plan:
    # bootstrap mode — agent's first decision in the loop
    channels: [system_query_result, system_mode_entry, widget_output, tool_call]
  retrieve:
    # handler-result-driven — `submit_retrieve` writes work.candidates
    channels: [system_query_result, widget_output, tool_call]  # NO system_mode_entry
  salvage:
    # mixed-entry mode — kept system_mode_entry intentionally
    channels: [system_query_result, system_mode_entry, widget_output, tool_call]
```

The narrow admission keeps `system_mode_entry` only where it's needed
(bootstrap or mixed-entry) and removes it from every handler-result-driven
mode. Refer to this example when explaining the fix.

## Limits

- The "bootstrap vs handler-result-driven" classification is
  heuristic. A mode whose entry is conditional (sometimes from a
  handler, sometimes from a widget) MAY need both channels. The
  linter WARNs on these; the program author must decide.
- The linter does not yet detect the `tool_call`/`widget_output`
  asymmetric case. If you suspect an asymmetric continuation issue,
  file Channel 4 on `simodelne/pgas` requesting a runtime warning per
  pgas#253 suggested upstream change #2.
