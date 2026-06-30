# SOTA Spec 3 (Facet C): full §10 REPL graduation, env-gated

- **Date:** 2026-06-30
- **Status:** Draft for build
- **Baseline:** pgas-new v3.6.0 (`main`)
- **Part of:** SOTA decomposition. This is Facet C — the v3 UAT contract's actual release gate.

## Problem
All verification so far drives the synthesis **engine path** directly (`synthesizeDomainLogic`) +
deterministic smoke. The **full interactive foundry**, where the bare `pgas-new` command starts the
REPL and an agent walks the user through `intake_intelligence → repo_targeting → architecture_design
→ scaffold_plan → domain_synthesis → branch_write → static_verify → smoke_verify → live_verify →
rebase_verify → pr_graduation`, is **not exercised end-to-end** as a committed, reproducible test.
The v3 UAT contract's release gate is exactly this clean live §10 graduation against Qwen.

## Goal
A **committed, env-gated** test that drives the real foundry REPL/CLI through the full mode chain
against local Qwen and asserts it produces a graduated program end-to-end.

## Design
1. **Driver:** programmatically start the foundry (REPL/CLI entry — the bare `pgas-new` foundry
   program / `createPgasServer` path used by the CLI) and feed a scripted intake mandate (Q1–Q6 +
   domain_spec), advancing through each mode by emitting the legal actions, including the
   `user_confirmation` approvals (design + artifact-plan).
2. **Substrate:** local Qwen (`PGAS_OPENAI_BASE_URL`/`PGAS_OPENAI_MODEL`). A standalone target (no
   external repo) so graduation is self-contained.
3. **Assertions:** reaches the terminal/graduation mode; artifacts written to the target dir;
   generated program passes its own static + smoke gates; graduation audit recorded. (PR graduation
   itself stops at producing the PR artifacts/branch — the test must NOT push/open a real PR; it
   asserts the graduation *artifacts/state*, not a GitHub side effect.)
4. **Gating (Codex review point):** env-gated behind `PGAS_LIVE_GRADUATION=1` (+ provider env).
   **When the gate env IS present, a skip MUST fail the run, not silently pass.** Default
   `npm run test:unit`/CI stays hermetic (test skips). This is nightly/release evidence, not default
   CI, because a multi-turn live-LLM REPL run is inherently slower/flakier.
5. **Robustness:** generous timeouts; deterministic seed input; fake clock/random where the harness
   allows; bounded retries on transient provider hiccups (distinguish transient from real failure).

## Integrity
- Real provider round trips (this is the point) — but **no real PR push / no GitHub side effects /
  no deploy**. Standalone target in a temp dir. No secrets/spend beyond local Qwen.
- Skip-with-env-present = FAIL (no silently-green gate).

## Acceptance
1. With `PGAS_LIVE_GRADUATION=1` + provider env: the test drives the real foundry REPL through the
   full mode chain against Qwen and asserts a graduated, gate-passing program (artifacts + audit).
2. With the gate off: test skips; hermetic suite + CI stay green.
3. No real PR/push/deploy; temp-dir target; no secrets.

## Out of scope
Real GitHub PR creation/merge (graduation asserts artifacts/state only). Facet B (loopback) is a
separate spec. Pushing/opening PRs from the test is explicitly forbidden.
