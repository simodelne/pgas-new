# SOTA Evaluation — Spec 1: Benchmark Corpus + Scoring Harness

- **Date:** 2026-06-29
- **Status:** Draft for owner review
- **Owner:** Simone
- **Baseline:** pgas-new v3.5.0 (`main`)
- **Advisory input:** Codex architecture review 2026-06-29 (verdict: SOUND WITH CHANGES — all incorporated).
- **Part of:** the SOTA target, decomposed into three specs. **This spec = Facet A only.**
  Facet B (localhost real-integration proof + hardened `repo_integration` gate) and Facet C
  (full §10 REPL graduation, env-gated release evidence) are **separate follow-on specs**.

## 1. Goal

Turn "SOTA" from an unfalsifiable label into a **measurable, repeatable pass/fail bar** for
the foundry's autonomously-generated programs, and build the harness that measures it.

**SOTA is defined as task success, not prettier code:** deterministic **pass@1 under a fixed
repair budget** across a governed benchmark corpus, with **100% of deterministic gates passing
per benchmark** (not merely in aggregate), and **no regression vs the v3.5.0 baseline**. A local
Qwen LLM-judge contributes **advisory, non-gating** qualitative color only.

This spec delivers the corpus + harness + scorecard + metrics. It does **not** itself make the
foundry pass the bar — running the harness is expected to expose foundry gaps; closing them is
the follow-on iteration loop (noted in §10).

## 2. Why the changes from the first sketch (Codex review)

- The same Qwen family that *generates* cannot credibly *judge* — so the qualitative judge is
  demoted to advisory/non-gating; the gating signal is deterministic oracle task-success.
- Fixtures authored from generated output are circular — so every benchmark ships an
  **independent, pre-authored oracle**.
- 5–8 cases invites teaching-to-the-test — so the corpus is tiered with a **hidden/rotating
  holdout** and adversarial/negative cases.
- A real product gap exists (`repo_integration_static_call` can pass without a real call) — that
  hardening lives in **Facet B / Spec 2**, not here, but is cross-referenced.

## 3. Scope

**In scope (Facet A):** corpus schema + content, the scoring harness, the scorecard artifact,
the metric set, baseline capture, holdout strategy, oracle-integrity (mutation) tests.

**Out of scope (other specs / not now):** localhost stub + real loopback assertion (Spec 2);
full interactive REPL §10 graduation (Spec 3); any external/hosted judge model; real third-party
credentials or spend. No network in this spec's benchmarks (pure-compute / llm-reasoning /
in-memory-mock archetypes only; real-call archetypes belong to Spec 2).

## 4. Corpus design (`tests/sota/corpus/`)

Each benchmark is a directory:

```
tests/sota/corpus/<benchmark-slug>/
  mandate.json      # the intake domain fed to the foundry (program.* + intake.* fields)
  oracle.ts         # INDEPENDENT reference: expected behavior, authored BEFORE synthesis
  inputs/*.json     # input fixtures (the oracle maps input -> expected output)
  rubric.md         # qualitative dimensions for the advisory Qwen judge (non-gating)
  meta.json         # archetype tags, holdout flag, expected stage topology, repair_budget
```

**Oracle discipline (load-bearing):**
- `oracle.ts` exports a reference `expected(input)` (and/or invariants) authored from the mandate,
  **independent of any generated code**. Generated programs are scored *against* the oracle.
- Generated code must never define a benchmark's expected outputs.
- A PR that changes both an `oracle.ts` and generator behavior must be flagged for explicit review
  (documented convention + a harness check that warns when both change together).
- **Oracle-integrity tests (mutation):** a hermetic test mutates known-good outputs and asserts the
  oracle/functional assertions REJECT them — proving the oracle actually discriminates.

**Corpus tiers:**
- **Committed dev set:** 5–8 benchmarks spanning pure-compute, llm-reasoning, multi-stage with
  cross-stage state dependencies, and in-memory-mock external-adapter. Frozen once added.
- **Stratified extension set:** larger, organized by archetype/difficulty (grow over time).
- **Holdout set:** a rotating/hidden set NOT used during foundry prompt/iteration tuning, run only
  to produce the headline SOTA number — guards against teaching-to-the-test.
- Include **negative/adversarial** cases (ambiguous/under-specified mandates, integration-error
  paths) where the correct behavior may be "refuse / surface gap," not "produce output."

## 5. Scoring harness

Per benchmark, the harness:
1. **Synthesizes** the program through the real foundry path (`synthesizeProgramSpecFromDomain` +
   `synthesizeDomainLogic`) against local Qwen — **env-gated** (`PGAS_LIVE_SYNTH=1` + provider env).
2. Runs **deterministic gates (all gating, must be 100% per benchmark):**
   - typecheck of the generated program;
   - smoke: reaches `completion.final_stage` with no `stage_action_stub`/`"todo"` in executed state;
   - behavioral gate (existing) passes;
   - **functional oracle assertions:** generated program's output for each input fixture matches
     `oracle.ts` (exact or invariant/property + metamorphic checks).
3. Records metrics (§6).
4. Optionally runs the **advisory Qwen judge** over the rubric → qualitative score, **reported
   separately, never gating**.
5. Emits a **scorecard** (committed artifact): per-benchmark results + aggregate, with model id,
   prompt hash, generated-body hashes, attempts, timings, and pass/fail per gate.

**Determinism / replay:** generated bodies are cached by hash (existing mechanism); the harness
supports deterministic replay from cache so a scorecard is reproducible without re-calling Qwen.

## 6. Metrics (codegen-eval discipline)

- **pass@1** under a fixed repair budget (per `meta.repair_budget`, default 4).
- **task success rate** = fraction of benchmarks passing 100% of deterministic gates.
- per-benchmark **attempts** and **latency**.
- **baseline comparison** vs v3.5.0 (store a baseline scorecard; flag regressions).
- **failure taxonomy:** classify each failure (typecheck / smoke / behavioral / functional-oracle /
  hard-fail-exhausted) for actionable iteration.
- qualitative advisory score (separate, non-gating).

## 7. SOTA verdict (the bar)

The foundry is "SOTA" for the corpus iff, **on the holdout set at pass@1 within repair budget**:
- 100% of deterministic gates pass for **every** benchmark (no aggregate masking), AND
- no regression vs the v3.5.0 baseline.
Qualitative advisory scores are published alongside but do not gate the verdict.

## 8. Hermetic vs gated execution

- **Hermetic (default `npm run test:unit`):** harness unit tests, oracle-integrity/mutation tests,
  scorecard schema tests, deterministic replay from a checked-in cache fixture. No live calls.
- **Gated (`PGAS_LIVE_SYNTH=1` + provider env):** the full synthesize-and-score corpus run against
  Qwen. **When the gate env IS present, a skip must FAIL the run, not silently pass** (Codex #4).

## 9. Components / files (anticipated)

- `tests/sota/corpus/<slug>/...` — benchmarks (mandate/oracle/inputs/rubric/meta).
- `tests/sota/harness.ts` — synthesize → score → metrics → scorecard.
- `tests/sota/score.ts` — deterministic gate runners + functional-oracle comparison + taxonomy.
- `tests/sota/judge.ts` — advisory Qwen qualitative scorer (non-gating).
- `tests/sota/scorecard/baseline-v3.5.0.json` + generated scorecards.
- `tests/sota/*.test.ts` — hermetic harness/oracle-integrity/replay tests.
- Reuses existing: `synthesizeProgramSpecFromDomain`, `synthesizeDomainLogic`, smoke/anti-stub,
  behavioral gate.

## 10. Acceptance criteria (for THIS spec)

This spec is done when:
1. The corpus schema + committed dev set (5–8 benchmarks across the named archetypes) exist with
   independent pre-authored oracles.
2. The harness runs hermetically (unit/replay/oracle-mutation tests green) and, when gated, runs
   the full corpus against Qwen and emits a scorecard.
3. **Oracle-integrity proven:** mutation tests show oracles reject wrong outputs.
4. A **v3.5.0 baseline scorecard** is captured and committed.
5. The first full gated scorecard is produced and recorded **honestly** — the headline number is
   reported as-is, including failures. (Reaching the SOTA threshold itself is the follow-on
   iteration loop, not a precondition for landing the harness.)

## 11. Risks / mitigations (Codex)

- **Self-referential scoring** → Qwen judge non-gating; gating = deterministic independent oracles.
- **Oracle circularity** → oracles authored before synthesis; mutation tests; same-PR oracle+generator
  change flagged.
- **Corpus overfit / teaching-to-the-test** → hidden/rotating holdout; frozen committed cases;
  adversarial/negative cases; headline number comes from holdout.
- **Score masking** → 100% deterministic pass *per benchmark*, not aggregate.
- **Flakiness of live runs** → deterministic CI vs gated live separated; replay from cache.
- **Security** → temp dirs, timeouts, import allowlists; no network in this spec.

## 12. Follow-on (separate specs)

- **Spec 2 (Facet B):** localhost stub service + harden `repo_integration` so the gate asserts a
  real loopback request/response (closes the `repo_integration_static_call` shallow-gate gap).
- **Spec 3 (Facet C):** committed, env-gated full §10 REPL graduation against Qwen (skip-with-env =
  fail). Nightly/release evidence, not default CI.
- **Doc-sync:** update `docs/PGAS-NEW-ARCHITECTURE.md` (still says "v3.1 / 10-Mode") to the current
  12-mode machine with `domain_synthesis` + `smoke_verify`.
