# SOTA 100% lane — evidence & decision (2026-07-08)

**Status:** PARKED evidence branch `fix/sota-100-proposal-ledger`. **Not for merge**
without an explicit product/model decision on the surface tradeoff (below).
Decision made under day-supervision delegated authority: do **not** merge the
broad flat `<stage>.result_json` surface as a "100%" fix — the 13/13 target is not
reliably achievable on `qwen36-27b`, and the change has broad generated-contract
blast radius.

## Branch

- `442f4a4a` fix(synth): expose pure-compute stage results at flat `<stage>.result_json`
- `67436e0d` test(sota): regenerate fee-calculator replay fixture for flat result_json

Base: `main` @ `17511d4f` (v3.13.0 line).

## Gates passed (repo-native, on the branch)

- `typecheck` ✓
- `test:manifest` ✓ (26/0)
- `test:unit` ✓ (496 passed / 6 skipped / 0 fail, single-fork)
- `test:static` ✓ — all checks; the lone `foundry-end-to-end` red is the known
  transient host-PID resource flake (green isolated + in the single-fork unit suite).
- SOTA replay hermetic test (`tests/sota/harness.test.ts`) ✓ (4/4) after fixture regen.

## Live evidence (qwen36-27b @ http://100.100.74.6:8000/v1)

Full-corpus with the fix: **12/13, pass@1 0.923, holdout 8/8, dev 4/5.**
Baseline (v3.13.0, no fix): 11/13, pass@1 0.846.

Per-benchmark across runs:

| Benchmark | Baseline | With fix | Read |
|---|---|---|---|
| refund-ledger-stateful | FAIL (7 attempts → #93 fallback) | **PASS** (4 attempts) | **model variance** |
| proposal-ops-stateful | FAIL (missing flat `result_json` — deterministic archetype-path barrier) | FAIL fresh, 4–6 attempts, all-real bodies, `approval_summary.result.approved: expected true, got undefined` | **consistent model wall** (multi-stage compute cascade) |
| other 11 | PASS | PASS | — |

Note: one full-corpus proposal-ops "fail" showed `attempts=0` — a body-cache
replay artifact (an earlier reproof wrote a buggy `approval_summary` body into the
shared `.body-cache`). A **fresh, cache-cleared** proposal-ops run still fails at
4 attempts, so the failure is genuine, not a cache artifact.

## Why 13/13 is model-bound on qwen36-27b

Both remaining failures reduce to one root cause: **the model unreliably
synthesizes correct multi-stage pure-compute stage bodies.** Evidence:

- refund-ledger passes on a good run, fails on a bad one (variance) — sometimes
  exhausts the repair budget and falls to the intentional #93 mechanical
  placeholder, which the functional oracle correctly catches.
- proposal-ops fails *consistently fresh*: all three stages (`estimate_fee →
  apply_discount → approval_summary`) synthesize as real bodies, but the model
  writes plausible-but-subtly-wrong code that breaks the data flow across the
  chain — `discounted_total_usd`/`budget_usd` don't reach `approval_summary` on
  the path their domain-specs dictate, so `approved` computes `undefined`.

The domain-specs are unambiguous; a stronger model would satisfy them. The
foundry + functional oracle are behaving correctly (they catch the hollow/wrong
output rather than green-washing it). This is not a foundry defect.

## What the flat-`result_json` change improves (and its cost)

- **Improves:** makes pure-compute stage results archetype-independent — a
  generated `mirror_<stage>_output` AfterRound reaction surfaces
  `<stage>.output.result_json`/`.items_json` at flat `<stage>.result_json`/
  `.items_json` (the shape llm-reasoning stages already expose via `from_arg`).
  This removes proposal-ops's *deterministic* archetype-path barrier — it becomes
  passable-in-principle (was unpassable before).
- **Cost / blast radius:** adds the flat paths + a mirror reaction to **every**
  generated program's contracts (`contracts_ts` changes), which is why the
  content-addressed SOTA replay cache key shifted and the fee-calculator replay
  fixture had to be regenerated. Broad, always-on surface addition.

## What a real fix would need (not done here)

1. **Stronger synthesis model** for stateful multi-stage compute — the actual
   lever for 13/13. The foundry side is already correct.
2. If the flat-`result_json` capability is still wanted, prefer a **narrower,
   default-off** design over the always-on broad surface: e.g. emit the flat
   mirror only for stages a declared consumer/projection references (demand-driven,
   mirroring the collection_lifecycle Phase-3 recommendation in
   `docs/superpowers/specs/2026-07-06-gap2-phase3-lifecycle-trigger-design.md`),
   so it is additive and least-surprising rather than a global contract change.

## Do NOT

Merge / publish / release / force-push / delete this branch, or broaden generated
contracts further, without an explicit product decision accepting the surface
tradeoff (or a model upgrade making 13/13 real).
