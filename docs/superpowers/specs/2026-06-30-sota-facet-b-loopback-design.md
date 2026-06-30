# SOTA Spec 2 (Facet B): real localhost integration loopback

- **Date:** 2026-06-30
- **Status:** Draft for build
- **Baseline:** pgas-new v3.6.0 (`main`)
- **Part of:** SOTA decomposition. Facet A (eval harness) shipped in v3.6.0. This is Facet B.

## Problem
Existing-repo external-adapter stages bind to a declared `.pgas/wiring.yml` integration and
generate a `repo_integration` adapter that imports the declared module and calls the declared
method. But the current gate is `repo_integration_static_call` — it verifies the import/call exist
**statically**, NOT that a real call happens at runtime. So "real integration" is asserted by code
shape, not behavior.

## Goal
Prove and enforce that a `repo_integration` adapter performs a **real network round trip** to the
declared integration at runtime, using a **localhost stub service** as ground truth — no secrets,
no spend, no real third party.

## Design
1. **Localhost stub service (test fixture):** a tiny in-process HTTP server bound to `127.0.0.1:0`
   (ephemeral port) with deterministic responses and a **request ledger** (records every received
   request). It owns the truth: the test asserts against the ledger + the program's use of the
   response. No external network; no credentials.
2. **Manifest integration → real HTTP call:** add/support an integration `kind: http_api` whose
   generated adapter performs a real `fetch` to the declared base URL + method path (URL injected
   via the repo-supplied `config_env` names at runtime — names only, values from the test env
   pointing at the stub). The adapter remains deterministic in shape; the call is real.
3. **Harden the gate:** augment/replace `repo_integration_static_call` so a `repo_integration` stage
   is verified by an **actual loopback request/response** (runtime evidence), not just static import
   presence. Record `adapter_kind: repo_integration` + a "real_call_verified" signal in the audit.
4. **Committed test** (`tests/integration/...` or `tests/sota/...`): synthesize a program whose
   external-adapter stage binds to the stub integration, run it, and assert: (a) the stub ledger
   recorded the expected request; (b) the program's stage output reflects the stub's response;
   (c) the audit marks a verified real call. Loopback is hermetic (localhost) so it can run in the
   normal suite, but live SYNTHESIS stays gated behind `PGAS_LIVE_SYNTH` (use a fixed/fake generator
   or replay for the hermetic portion; real call is exercised regardless).

## Anti-cheat / integrity
- Localhost only; no real external service, no credentials/secrets, no spend.
- The stub ledger is the oracle for "a real call happened"; the adapter must not be able to pass by
  faking the response without calling.
- No per-slug special-casing; general `http_api` integration capability.

## Acceptance
1. A generated `repo_integration` (http_api) adapter makes a verified **real loopback** request to
   the localhost stub and consumes its response.
2. The shallow `repo_integration_static_call` gate is augmented/replaced by **real-call evidence**.
3. Hermetic ladder stays green; live synthesis remains gated.
4. No secrets/spend; localhost only.

## Out of scope
Real third-party credentials (future, owner-gated). Facet C (REPL §10 graduation) is a separate spec.
