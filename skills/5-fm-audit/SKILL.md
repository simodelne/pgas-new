---
name: pgas:5-fm-audit
description: Audit a pgas consumer against the 5 failure modes from pgas#253 (FM1-FM5). Run before cutting any version that bumps @simodelne/pgas-* from v1.2.x → v1.8.x, or whenever a consumer's session stalls without a `trigger_failed` or `round_execution_failed` event. Reports file:line citations for every finding.
---

# pgas:5-fm-audit

Audit a pgas consumer against the five integration gaps documented in
[pgas#253](https://github.com/simodelne/pgas/issues/253). Each FM is a
**silent-degradation** failure (no `trigger_failed`, no
`round_execution_failed`) and each cost the pgas-rag orchestrator real
debug time before codex repaired it. This skill mechanically checks
each one and reports file:line citations.

## When to use

- Before cutting a consumer release that bumps `@simodelne/pgas-*` from
  `^1.2.x` to `^1.8.x` (or higher).
- Whenever a consumer's session stalls without a `trigger_failed` or
  `round_execution_failed` NDJSON event.
- As a pre-publish gate the orchestrator runs once per consumer cut.

## Setup

Run from the **consumer repo root**. The audit assumes:

```bash
test -f package.json
test -d node_modules/@simodelne/pgas-server
```

If `node_modules/@simodelne/pgas-server` is missing, run `npm install`
first — the audit reads the installed package's exports.

## FM1 — Handlers read action payload only; engine stores flat-key domain

**The bug** (pgas#253 FM1, codex commits `fcb49be`, `10c23c9`): the
engine stores `inputs.answers.user_intent` at the flat key
`domain['inputs.answers.user_intent']`, but the action payload passed
to handlers only contains explicit author-facing args. Handlers that
read **only** the payload silently get `undefined` for any field the
author didn't pass.

**The fix**: every handler that reads engine-managed fields
(`work.*`, `inputs.*`, `decisions.*`) must declare a domain-fallback
resolver. The pattern lives in the plugin's
`templates/new-program/handlers/_resolver.ts`.

**Audit step**:

```bash
# 1. Find all handler files
HANDLER_FILES=$(find programs src -type f \( -name "*.ts" -o -name "*.js" \) \
                 -not -path "*/node_modules/*" -not -path "*/dist/*" \
                 | xargs grep -l "handlers\s*[:=]" 2>/dev/null)

# 2. For each, check whether any function in it ALSO references the domain
# (a healthy handler reads both payload and domain; an FM1 candidate reads only payload)
for f in $HANDLER_FILES; do
  if grep -E "function\s+\w+\(\s*(payload|args|action)" "$f" >/dev/null \
     && ! grep -E "(domain|world|getDomain|flatKey|_resolver)" "$f" >/dev/null; then
    echo "FM1-CANDIDATE: $f — uses payload but never reads domain/world"
  fi
done
```

**Pass condition**: every handler that reads engine-managed paths also
references the domain snapshot (a `_resolver.ts` helper, a
`getDomain(...)` call, or a `flatKey` lookup).

**Fail condition**: any handler reads only its action payload. Report
the file path + the function signature.

## FM2 — InnerContinuationReplay + SessionLockExhausted consumers must be wired

**The bug** (pgas#253 FM2, codex commit `4ae99e2`): pgas-server v1.8.1
exports `createInnerContinuationReplayConsumer` and
`createSessionLockExhaustedConsumer`, but consumers that only inherited
`^1.2.x` bootstrap code never registered them. Deferred continuations
have nowhere to be replayed → session stalls → lock queue depth rises
1→7 → eventual 50-minute drain → `status=Failed` from lock exhaustion.

**The fix**: register both consumers immediately after mode-entry
continuation in the consumer's `server/index.ts`. The plugin's
`templates/new-consumer/server/index.ts.tmpl` already does this.

**Audit step**:

```bash
# 1. Find the consumer's server bootstrap
BOOTSTRAP=$(grep -rln "import.*@simodelne/pgas-server" \
              --include="*.ts" --include="*.js" \
              -- server src 2>/dev/null | head -3)

# 2. For each, check both consumer factories are referenced
for f in $BOOTSTRAP; do
  HAS_REPLAY=$(grep -c "createInnerContinuationReplayConsumer" "$f")
  HAS_LOCK=$(grep -c "createSessionLockExhaustedConsumer" "$f")
  if [[ "$HAS_REPLAY" -eq 0 ]]; then
    echo "FM2-FAIL: $f — missing createInnerContinuationReplayConsumer registration"
  fi
  if [[ "$HAS_LOCK" -eq 0 ]]; then
    echo "FM2-FAIL: $f — missing createSessionLockExhaustedConsumer registration"
  fi
done
```

**Pass condition**: at least one bootstrap file imports AND invokes
both consumer factories.

**Fail condition**: either factory is missing. Cite the file + the
canonical wiring example: the scaffold's
`templates/new-consumer/server/index.ts.tmpl` (the
`createInnerContinuationReplayConsumer(...)` +
`createSessionLockExhaustedConsumer(...)` calls, imported from the
`@simodelne/pgas-server/api` barrel — never the bare specifier).

**Note**: if the consumer uses pgas-server's hosted `createServer()`
factory (which wires both consumers automatically), this FM is N/A.
The audit should detect that case by checking for a `createServer(`
call in the bootstrap.

## FM3 — system_mode_entry channel breadth that worked in ^1.2.x

**The bug** (pgas#253 FM3, codex commit `eb27ac9`): consumer spec.yml
declared `system_mode_entry` globally on every nonterminal mode. That
was correct under `^1.2.x` (issue #98 — widget notices needed a second
round to re-evaluate post-mutation guards). Under `^1.8.x`,
`ModeEntryContinuation` checks the target mode channel list AND
sync-out replay feeds handler results back as `system_query_result`.
The broad admission now overlaps with the replay path, generating
duplicate continuations per mode transition.

**The fix**: narrow `system_mode_entry` to genuine bootstrap modes
only (`plan`, `describe`, `salvage` in pgas-rag's case). Keep it OFF
handler-result-driven modes.

**Audit step**: invoke the `pgas:mode-entry-lint` skill on every
`spec.yml` under `programs/`. That skill is the dedicated FM3 linter
and is included in this plugin.

```bash
for spec in $(find programs -type f \( -name "spec.yml" -o -name "specs.yml" \) 2>/dev/null); do
  echo "--- $spec ---"
  # invoke the linter skill (see skills/mode-entry-lint/SKILL.md)
done
```

**Pass condition**: every mode admitting `system_mode_entry` is a
bootstrap mode (no handler writes data the mode consumes).

**Fail condition**: a handler-result-driven mode admits
`system_mode_entry`. Cite the mode name + the relevant
`channels:` line.

## FM4 — Raw tools: handler-backed vs registry-backed adapter dispatch

**The bug** (pgas#253 FM4, codex commit `c71a2cb`): `compileTools`
compiles `tools.submit_generate` to a generated action name with empty
mutations. The default adapter looks for
`handlers['invoke_tool_submit_generate']`, finds none, returns
`undefined`. Session stays in mode, no `work.answer`, no
`trigger_failed`.

**The fix**: handler-backed raw tools must have explicit
`createAdapters` overrides for the `tool:<name>` channel AND must
declare the channel in `syncOutContinuationPolicy.channels`. The
canonical place for that override is the program's `registration.ts`,
which the scaffold now ships: it calls
`createProgramAdapters(spec, ctx, handlers)` and then re-`set`s each
`tool:<name>` output to a registry/handler adapter inside its
`createAdapters: (ctx) => { … }` closure. (See pgas-rag
`programs/legal-rag/registration.ts` — the `adapters.outputs.set('tool:…', …)`
lines after `createProgramAdapters`.)

**Audit step**:

```bash
# 1. Find every spec — extract its tools declarations
for spec in $(find programs -type f \( -name "spec.yml" -o -name "specs.yml" \) 2>/dev/null); do
  PROG_DIR=$(dirname "$spec")
  RAW_TOOLS=$(yq '.tools | keys[]' "$spec" 2>/dev/null)
  for t in $RAW_TOOLS; do
    # 2. Check whether the program's registration.ts (canonical location)
    #    or the consumer bootstrap declares a createAdapters override for
    #    tool:$t — `adapters.outputs.set('tool:$t', …)` is the override.
    if ! grep -rln "tool:${t}" --include="*.ts" -- "$PROG_DIR" server src 2>/dev/null | head -1 >/dev/null; then
      # 3. Check whether handlers[invoke_tool_$t] exists — if not, it's an FM4 candidate
      if ! grep -rln "invoke_tool_${t}" --include="*.ts" -- programs src 2>/dev/null | head -1 >/dev/null; then
        echo "FM4-CANDIDATE: tool '$t' in $spec — no createAdapters override (checked $PROG_DIR/registration.ts) AND no invoke_tool_${t} handler"
      fi
    fi
  done
done
```

The canonical override to look for is, inside `registration.ts`'s
`createAdapters` closure:

```ts
createAdapters: (ctx) => {
  const adapters = createProgramAdapters(spec, ctx, handlers);
  adapters.outputs.set('tool:<name>', /* registry/handler adapter */);
  return adapters;
},
```

**Pass condition**: every raw tool either (a) has a registered handler
named `invoke_tool_<name>`, or (b) has an explicit `createAdapters`
override for the `tool:<name>` channel (in `registration.ts`) AND is
listed in `syncOutContinuationPolicy.channels`.

**Fail condition**: a raw tool has neither. The default adapter will
silently `undefined` and the session will stall.

## FM5 — Engine-owned inputs.query_meta.* paths not in consumer spec schema

**The bug** (pgas#253 FM5, codex commit `f139799`): the v1.8.x engine
emits `system_query_result` replay envelopes with
`inputs.query_meta.{source_path, source_channel, message,
scope_redirect, continuation_round}`. If the consumer's spec.yml
doesn't declare those leaf paths, `validateChannelEvent` rejects the
replay with `ClientInputError: Payload path "inputs.query_meta.message"
is not schema-declared`.

**The fix**: declare the engine-owned continuation metadata schema in
spec.yml. Ideally use a spread import from `@simodelne/pgas-contracts`
once `engineOwnedContinuationPaths` is exported.

**Audit step**:

```bash
# Required engine-owned paths (mirror of @simodelne/pgas-contracts/engine-paths.ts)
REQUIRED=(
  "inputs.query_result.kind"
  "inputs.query_result.value_json"
  "inputs.query_meta.source_path"
  "inputs.query_meta.source_channel"
  "inputs.query_meta.continuation_round"
  "inputs.query_meta.scope_redirect"
  "inputs.query_meta.message"
)

for spec in $(find programs -type f \( -name "spec.yml" -o -name "specs.yml" \) 2>/dev/null); do
  for p in "${REQUIRED[@]}"; do
    # Schema entries are flat dotted keys, e.g. `inputs.query_meta.message: string`.
    if ! grep -qE "^[[:space:]]*${p}:" "$spec"; then
      echo "FM5-FAIL: $spec missing engine-owned path declaration: $p"
    fi
  done
done
```

**Pass condition**: every spec.yml declares all 7 engine-owned paths in
its `schema:` block.

**Fail condition**: any spec is missing one or more. Cite the spec
file + the missing path list.

## Reporting format

Emit a final summary:

```
pgas:5-fm-audit report
  consumer: <name from package.json>
  installed pgas-server version: <from node_modules/.../package.json>

  FM1 — domain-fallback resolver: <PASS/FAIL>
    findings: <file:line list>
  FM2 — replay+lock-exhausted consumers wired: <PASS/FAIL>
    findings: <file:line list>
  FM3 — system_mode_entry breadth: <PASS/FAIL/N/A>
    findings: <mode + channels: line list>
  FM4 — handler-backed raw tools: <PASS/FAIL>
    findings: <tool name + spec file list>
  FM5 — engine-owned query_meta paths: <PASS/FAIL>
    findings: <spec + missing paths>

  Overall: <PASS / X failures>
```

A FAIL is a hard recommendation to fix BEFORE cutting the next consumer
version. Each FAIL maps to a worked example in pgas#253 — link the
issue in your fix PR.

## Limits

This audit reads installed source. It does NOT run the consumer's
sessions. A consumer that passes the audit can still stall for reasons
outside the five FMs (model regressions, prompt drift, infra issues,
etc.). The audit is **necessary, not sufficient** for a healthy
consumer cut.

When the audit reports `N/A` for FM2 (e.g. the consumer uses
`createServer()`), or for FM3 (e.g. no `system_mode_entry` channel is
declared anywhere), the consumer is structurally immune to that FM and
the audit treats it as a pass.
