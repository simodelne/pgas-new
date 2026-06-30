# Curator request: normalize/reject whitespace-padded tool-arg keys at the gates

- **Date:** 2026-06-30
- **Upstream:** `@simodelne/pgas-server` (engine monorepo `simodelne/pgas`)
- **Origin:** pgas-new dogfooding issue simodelne/pgas-new#68
- **pgas-new version:** 3.7.0 · engine 2.16.0

## Why this is upstream (engine boundary)
The `GK*` gates (`GKParse`, `GKType`, `GKStructural`, `GKPairing`, `GKPrecondition`,
`GKTransition`) are engine-owned (`@simodelne/pgas-server`). pgas-new is a read-only consumer
of public exports and cannot change gate validation behavior. This request asks the engine
curator to harden the gate layer.

## Observed (pgas-new#68)
A native tool call for `record_q2_entry_channel` included an argument key with **trailing
whitespace**: `"message "`. All gates passed and the malformed key reached the handler / terminal
payload unchanged.

- Session `pgas-new-1782821711150`, log seq 101 (raw tool call), seq 102 (`llm_call.toolArgs`
  preserves `"message "`), seq 113 (all gates pass), seq 113/114 (terminal payload still `"message "`).

## Requested change
At the tool-call argument-validation boundary (before/within GKType), either:
1. **Normalize** argument keys (trim surrounding whitespace) prior to schema/type checks, OR
2. **Reject** unknown keys that differ from a declared parameter only by surrounding whitespace.

A trailing-/leading-space key must not silently pass as a distinct argument.

## Impact
Required fields can appear visually present in cards/logs while handlers and `action_map`
mutations read a different (correct) key — a silent-correctness hazard for every generated program,
not just the foundry.

## Notes
No safe pgas-new-side fix exists at the gate layer (read-only boundary). A defensive handler-side
key-normalization in generated programs is possible as a stopgap but does not address the gate
contract; the durable fix is upstream.
