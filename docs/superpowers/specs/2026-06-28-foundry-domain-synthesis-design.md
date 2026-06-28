# Foundry Domain-Logic Synthesis — Design Spec

- **Date:** 2026-06-28
- **Status:** Draft for owner review
- **Owner:** Simone
- **Baseline:** pgas-new v3.4.2 (`main` @ `3d71b011`), engine `@simodelne/pgas-server` 2.16.0
- **Advisory inputs:** Codex 0.142.3 architecture review (2026-06-28); engine-type verification of the state-write contract.

## 1. Problem

Today the foundry's `architecture_design` step runs a **deterministic** synthesizer
(`src/foundry-program/synthesizer.ts`) that emits a correct, type-safe, governed
**skeleton**: `specs.yml` (modes, per-stage actions, single-hop transitions, guards,
`action_map` mutations) plus typed `result_json`/`items_json` schemas. But every
per-stage **body** is an honest TODO stub — `handlers.ts` returns
`{ kind: 'stage_action_stub', result_json, todo: ... }` and `tools.ts` carries
`TODO: implement local tool/adapter logic`.

So the foundry produces a SOTA *scaffold*, not a working program. The one fully
working example (`docs/graduation-evidence/fee-proposal-drafter`) had its handler
bodies **hand-filled** after generation; it is evidence of the target quality bar,
not proof the foundry reaches it autonomously.

### 1.1 The load-bearing contract finding (verified)

Generated stage state is written by `action_map` mutations of the form
`{ op: MSet, path: <stage>.result_json, from_arg: result_json }`. Per the engine
types (`_shared-types.d.ts:571-588`), `from_arg` resolves the value from the **LLM
tool-call argument**, *not* the handler's return. Therefore, even in the hand-filled
`fee-proposal-drafter`, the handler computes real fee math but governed state is
populated from whatever arg the model passes. **Replacing a stub body alone does not
make deterministic computation the source of truth.**

The fix exists first-class in the engine: `ActionSemantics.result_path`
(`_shared-types.d.ts:636`) — *"an EffectAction with a declared `result_path` lands its
tool result"* into governed state (`_shared-types.d.ts:3841`). No upstream/curator
change is required.

## 2. Goal & Scope (owner-confirmed)

- **Target:** the foundry **autonomously** generates **real per-stage domain logic**
  (no TODO stubs in executed paths) and the program **runs end-to-end**, with
  minimal/zero human filling.
- **Scope of "runs for real":**
  - *pure-compute* and *llm-reasoning* stages run for real;
  - *external-adapter* stages in **standalone** programs get a generated working
    **in-memory mock** plus a `TODO(real-service-swap)`;
  - *external-adapter* stages in **existing repos** must bind to a matching real
    integration declared by `.pgas/wiring.yml` when one exists. If no matching
    integration is declared, synthesis keeps the in-memory mock but records the
    gap explicitly in audit/curator-facing output.
- **Failure policy:** per-stage `generate → verify → repair` loop, then **hard-fail**
  (no silent stub fallback) if a stage never passes.
- **Substrate:** synthesis uses the engine's configured provider = **local Qwen
  `qwen36-27b`** at `100.100.74.6:8000`. No new spend, single substrate; the repair
  loop carries quality weight.

### 2.1 Non-goals (this version)

- Discovering or inventing integrations not published by the target repo manifest.
- Reading secret values for integrations. The manifest supplies env var **names**
  only; generated adapters import the declared module and do not read env values.
- A stronger/dedicated codegen model — deferred; build provider-agnostic but prove on Qwen.
- Whole-program single-shot LLM generation or LLM whole-program repair (Codex: least robust).

## 3. Chosen Approach

**Codex A-variant:** per-stage LLM body generation against frozen deterministic
contracts, per-stage verify→repair→hard-fail, plus a **deterministic (non-LLM)**
whole-program coherence + smoke gate. The LLM never rewrites whole programs and never
edits the contract; any coherence-pass finding that needs a code change is routed back
through the same per-stage gate.

Rejected: **B** (whole-program single-shot — failures non-localizable, poor 27B fit);
**C** as originally posed (final *LLM* coherence pass — only acceptable if read-only/
deterministic, which is what §5 adopts).

## 4. Per-Stage Archetype → State-Write Contract

The stage classifier tags each stage; the tag selects the state-write mechanism so that
deterministic output is the source of truth where it should be:

| Archetype | Work done by | State-write mechanism | Body generated? |
|---|---|---|---|
| `pure-compute` | deterministic handler | **`result_path`** lands handler return | yes (LLM) |
| `llm-reasoning` | model at runtime | **`from_arg`** (current pattern; the model *is* the logic) | no body; tune prompt/schema |
| `external-adapter` standalone or unmatched existing repo | generated in-memory mock | **`result_path`** lands mock return; `adapter_kind:"in_memory_mock"` recorded, with audit gap for unmatched existing repo | yes (LLM, mock) |
| `external-adapter` matched existing repo | generated adapter importing the manifest-declared module and calling the declared method | **`result_path`** lands real adapter return; `adapter_kind:"repo_integration"` and integration name recorded | yes (deterministic manifest-bound adapter) |

This means `synthesizer.ts` must, per stage, emit either a `from_arg`-driven action
(llm-reasoning) or a `result_path`-driven action (compute/external). This is the
breaking change to the generated state contract.

## 5. Architecture (layers)

1. **Deterministic synthesizer (kept, expanded).** Owns topology + `specs.yml`, and now
   also emits, per program: a single typed `contracts.ts` (stage input/result types
   derived from the schemas), deterministic **wrappers** (one per stage; owns PGAS payload
   shape, schema validation, serialization, and the state-write protocol), and the
   smoke-test scaffold. The LLM never touches these; they are the frozen contract.
2. **Stage classifier.** Assigns each stage `pure-compute | llm-reasoning |
   external-adapter` from the design-interview answers + mandate. Deterministic mapping
   with explicit, recorded rationale per stage (audit output).
3. **Body synthesizer (new, LLM = Qwen).** Generates **only** `stages/<stage>.ts`
   implementing `runStage(input, runtime): StageResult` against the frozen contract. The
   wrapper, not the body, performs state writes.
4. **Per-stage verify → repair loop.** typecheck + AST safety + anti-stub +
   a stage-local **behavioral fixture**. Each generated pure/mock body is executed
   against a deterministic input/runtime and must return key expected values
   (`result_json.stage`, non-empty `items_json`, and adapter kind for mocks).
   Manifest-bound repo adapters are checked against the declared import/method call.
   On failure, the repair prompt receives **only** the frozen contract + compiler/test
   errors (never the growing conversation). Cap `N` attempts (default 4). Detect repeated
   code-hash or repeated error-signature → stop early. On persistent failure → **hard-fail**
   with a stage-local report (stage, last attempt, errors, attempt count).
5. **Deterministic whole-program gate (no LLM edits).** Graph reachability, cross-stage
   schema compatibility, AST import-allowlist scan, anti-stub scan, then the smoke run
   (§7). Any required change re-enters step 4 for the offending stage.

## 6. Foundry mode change (governance-sensitive)

Per CLAUDE.md, `src/foundry-program/specs.yml` is the load-bearing design contract; this
adds a **new mode** (owner chose option (b)).

- **New mode `domain_synthesis`** inserted between `scaffold_plan` and `branch_write`:
  `scaffold_plan → domain_synthesis → branch_write`.
  - Entry gate: artifact plan approved (`artifact_plan.approved`/`write_authorized`).
  - Work: classify stages, generate bodies, run the per-stage verify→repair loop in a
    staging area, record synthesis audit (per-stage archetype, attempts, body hash,
    `adapter_kind`). Exit gate: all stages produced accepted bodies (or hard-fail).
  - `branch_write` then writes all planned artifacts (now including accepted bodies) to disk.
- **New verification rung `smoke_verify`** inserted between `static_verify` and
  `live_verify`: `static_verify → smoke_verify → live_verify`.

Updated foundry machine (11 modes + `curator_request`):
`intake_intelligence → repo_targeting → architecture_design → scaffold_plan →
domain_synthesis → branch_write → static_verify → smoke_verify → live_verify →
rebase_verify → pr_graduation` (`curator_request` remains the lodge-and-stop branch).

This change to the foundry's own spec is the program-nature-touching part; it is the
deliberate, surfaced decision required by CLAUDE.md, not drift.

## 7. `smoke_verify` rung (deterministic release gate)

A generated `tests/generated-program-smoke.test.ts` per program drives it through its
mode chain using the PGAS testing harness with: a fixed seed input, fake clock/random
(via `StageRuntime`), in-memory mocks for external stages, no secrets, no real network.

Assertions:
- terminal mode == `completion.final_stage`;
- every traversed stage produced parseable, schema-valid `result_json`/`items_json`;
- **no** executed-path output has `kind:"stage_action_stub"`, a `todo` field, a default
  `{}`/`[]` fallback, or other stub markers (anti-stub is first-class);
- state-output digest == handler/tool result digest (proves `result_path` wiring landed
  the deterministic output into governed state);
- branch guards open **exactly** the chosen single-hop transition;
- mock adapters are explicitly recorded as mocks.

The existing **§10 live UAT against Qwen** stays as a separate real-provider rung
(`live_verify`). `smoke_verify` proves the generated code runs deterministically; the
live UAT proves the provider can drive the program. **Both gate release**; hard-fail
otherwise (per §2 failure policy). This satisfies the v3 UAT contract's "no shipping
with a documented gap" — anti-stub + smoke + live are all green or the run fails.

## 8. Robustness moves (adopted from Codex)

- **Determinism.** `StageRuntime` injects clock/random/LLM. Synthesis uses temp=0/seed
  where available, but the **accepted cached code is the source of truth**, not
  re-generation. Cache key = hash(stage contract + prompt + model id + provider URL +
  synthesis version).
- **Idempotent re-synthesis.** Unchanged contract hash → reuse accepted body. Changed
  stage → invalidate it **and downstream dependent stages only**.
- **Cross-stage type drift.** Single generated `contracts.ts`; stage N imports prior
  stages' result types and never redefines them; runtime-validate every
  `result_json`/`items_json` (GKType) before state write; use `coerce` for known
  provider shape drift (`_shared-types.d.ts:614`).
- **Prompt-injection defense.** Mandate/stage descriptions passed as **untrusted JSON**.
  AST-enforced import allowlist. Ban `eval`, dynamic `import()`, `child_process`, shell,
  raw network, and secret/env reads unless an explicit adapter contract allows them.
- **Mocks never mask integration.** Standalone and unmatched existing-repo external
  stages record `adapter_kind:"in_memory_mock"` in audit + generated docs; unmatched
  existing-repo stages also record an explicit integration gap. Matching existing-repo
  stages record `adapter_kind:"repo_integration"` plus the integration name/import/method.
  The generated-code import allowlist is opened only for the manifest-declared module
  on that adapter stage.
- **Golden regression.** 3–5 representative mandate fixtures. Snapshot deterministic
  artifacts exactly; snapshot generated-body hashes + audit metadata (not fragile
  formatting).
- **Anti-stub is first-class.** UAT/smoke fail on stub markers in executed paths. The
  only permitted residual marker is `TODO(real-service-swap)`, and only inside
  external-adapter mock files.

## 9. Component / file impact (anticipated)

- `src/foundry-program/specs.yml` — add `domain_synthesis` + `smoke_verify` modes,
  transitions, actions, projections (governance-reviewed).
- `src/foundry-program/synthesizer.ts` — emit `contracts.ts`, per-stage wrappers, smoke
  scaffold; switch compute/external actions from `from_arg` to `result_path`.
- New: stage classifier, body synthesizer + per-stage verify/repair driver, deterministic
  coherence/anti-stub/import-allowlist checks, `StageRuntime`, cache/idempotency layer.
- `src/pgas-new/artifact-plan.ts` + `template-renderer.ts` — plan/render the new
  `stages/`, `contracts.ts`, wrappers, smoke test.
- `src/pgas-new/verify.ts` / `gates.ts` — add `smoke_verify` rung + anti-stub gate.
- Tests: unit (classifier, repair loop, anti-stub, cache idempotency), static, golden
  fixtures, and a refreshed §10 live UAT proving a **filled** program graduates.

## 10. Acceptance criteria

1. A non-stub program is synthesized end-to-end for a self-contained mandate, with no
   executed-path stub markers.
2. `smoke_verify` passes deterministically (digest equality proves `result_path` wiring).
3. Each body-synthesized stage passes its deterministic behavioral fixture, or fails
   through the repair loop with the behavioral failure included in the repair prompt.
4. Existing-repo external adapters bind to matching `.pgas/wiring.yml` integrations
   and emit `adapter_kind:"repo_integration"`; unmatched existing-repo and standalone
   adapters remain explicit mocks.
5. The **§10 live UAT against Qwen** passes for the synthesized program (real-provider rung).
6. Hard-fail behavior verified: an intentionally unsatisfiable stage causes a loud,
   stage-local failure with no PR graduation and no stub fallback.
7. Idempotent re-synthesis verified: unchanged contracts reuse cached bodies; a changed
   stage invalidates only itself + downstream dependents.
8. Golden fixtures stable across runs (deterministic artifacts byte-identical; body
   hashes recorded).

## 11. Risks / open questions

- **27B codegen ceiling.** If Qwen cannot reliably pass the per-stage gate for richer
  domains, the hard-fail policy will surface it loudly (by design). Mitigation path is the
  deferred stronger-model knob (§2.1), reopened only on evidence.
- **`result_path` ergonomics.** Need to confirm the exact wrapper pattern that lands a
  handler return at `result_path` for a synthesized-tool action (no explicit `tools:`
  block) during the writing-plans phase, with a tiny spike against the testing harness.
- **Mode-count change.** Adds modes to the foundry's own spec; must keep all existing
  modes intact and re-run the full §10 ladder to prove no regression in the foundry itself.
