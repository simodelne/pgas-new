# Mandate — policy-drafting

This MANDATE captures what v3.0's `synthesize_program_spec` action should produce when given this intake. The artifacts in this directory are the frozen v2.x baseline used for regression testing.

## Q1 Purpose
Draft risk-based policies by collecting policy context, requiring outline approval, drafting section by section, and preparing Word plus HTML output attachment payloads.

## Q2 Entry channel
user_text

## Q3 Stages
1. intake — Collect policy objectives, policy type, organization profile, risk appetite, available resources, audience, and jurisdiction.
2. outline — Propose a risk-based policy outline and request approval before drafting.
3. drafting — Draft the approved policy section-by-section and prepare output attachment payloads.
4. revision — Apply user-requested revisions while preserving the approved outline unless changed by the user.
5. complete — Report completion and the available output artifacts.

## Q4 Decision points
- intake → outline when intake.complete = true
- outline → drafting when outline.approved = true
- drafting → revision when revision.requested = true
- drafting → complete when outputs.ready = true
- revision → drafting when revision.applied = true
- revision → complete when outputs.ready = true

## Q5 Delegation
none

## Q6 Completion criteria
- Terminal mode: complete
- Guard: outputs.ready = true
