# Mandate — fee-proposal-drafter

Graduation evidence for the v3.4.0 **per-stage action** synthesizer (#55) plus a
**filled** handler exemplar (v3.4.1). Unlike the other evidence programs, the
handlers here are not stubs: each per-stage action is implemented with real,
self-contained fee-proposal domain logic to demonstrate the production quality a
generated program reaches once an implementer fills the synthesized stubs.

This is **evidence, not product surface** (per SI-2): the foundry's generic
synthesizer/templates are unchanged; nothing here is surfaced as a CLI `--template`.

## Provenance
Synthesized by `pgas-new` (foundry on `main`, v3.4.0) from the intake below, then
the per-stage handler stubs were filled with real logic. The frozen synthesized
spec is `specs.yml.frozen`; the filled handlers are `handlers.ts.tmpl`. The filled
handlers typecheck cleanly against the published `@simodelne/pgas-server` engine
types (`tsc --noEmit`, exit 0).

## Q1 Purpose
Draft elaborate client fee proposals for simoneos: capture the engagement request,
analyze scope, load the applicable rate card, estimate effort, build a fee model,
apply risk adjustments, assemble the proposal document, route it through partner
review with a revision loop, and deliver a client-ready proposal.

## Q2 Entry channel
user_text

## Q3 Stages
1. request_intake (bootstrap) — capture the engagement request.
2. scope_analysis — classify matter complexity; derive phases + deliverables.
3. rate_card_lookup — apply the role rate card with a jurisdiction multiplier.
4. effort_estimation — estimate hours per phase × role from complexity.
5. fee_modeling — compute hourly / fixed / capped quotes and a blended rate.
6. risk_adjustment — apply urgency/novelty risk premiums.
7. draft_assembly — assemble the proposal document (scope, fees, assumptions, terms).
8. partner_review — branch: changes_requested → revision, or approved → client_delivery.
9. revision — apply a revision discount, loop back to partner_review.
10. client_delivery (terminal) — finalized, client-ready proposal.

## Q4 Transitions
Linear request_intake → … → draft_assembly → partner_review; partner_review
branches to revision (`review.changes_requested`) or client_delivery
(`delivery.sent`); revision loops back to partner_review (`revision.completed`).
CyclicTopology (the review/revision loop).

## Q5 Delegation
None (single-program; no sub-agent delegation).

## Q6 Completion
final_stage: client_delivery; guard_field: delivery.sent.

## What the filled handlers demonstrate
- **Per-stage scoped actions** — each `complete_<stage>` / `advance_partner_review_to_*`
  action writes only its own guard + `result_json`/`items_json`; firing one advances
  exactly one hop (the v3.4.0 topology guarantee).
- **Real chained computation** — each handler reads prior stages' `result_json` from
  the engine domain snapshot and computes the next artifact (scope → rates → effort →
  fee model → risk-adjusted fees → assembled document). Pure computation; no external
  services required.
- **Enforced decision point** — `advance_partner_review_to_revision` vs
  `advance_partner_review_to_client_delivery` set mutually-exclusive branch guards.
