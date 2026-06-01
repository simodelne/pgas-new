<!--
  PR template — see qc/AGENT_CONTRACT.md + CLAUDE.md "Agent behavior".
  Sub-agent PRs MUST fill the "Brief" section verbatim. The orchestrator
  reviews every PR before merge; auto-merge is allowed but the orchestrator
  queues it.
-->

## Brief

<!--
  If this PR was opened by a sub-agent under the orchestrator pattern,
  paste the brief you were given here, verbatim. For direct commits by
  the curator/orchestrator, write "N/A — direct orchestrator commit".
-->

## Summary

<!--
  1-3 bullets. What changed and why. Focus on the why — the diff covers
  the what. Cite the observation that motivated the change when
  applicable (per the data-driven-debugging rule).
-->

## Test plan

<!--
  Bulleted checklist of verification steps.
-->

- [ ] `npm test` passes
- [ ] `npm run typecheck` passes
- [ ] (if `programs/**/spec.yml` touched) `/pgas:spec-validate` passes
- [ ] (if `programs/**/spec.yml` touched) `/pgas:mode-entry-lint` passes
- [ ] (if cutting a minor or major version) architecture doc updated per `/pgas:architecture-doc`

## pgas-version alignment (Channel 1)

- Latest published pgas: `<run npm view @simodelne/pgas-runtime version --registry=https://npm.pkg.github.com>`
- This consumer's pin: `<from package.json>`
- Aligned? yes / no — if no, why not (Channel 2 broadcast pending? breaking-bump migration in flight?)

## FM-closure check (pgas#253)

- [ ] FM1 — handlers use domain-fallback resolver where appropriate
- [ ] FM2 — `createInnerContinuationReplayConsumer` + `createSessionLockExhaustedConsumer` still wired in `server/index.ts`
- [ ] FM3 — `system_mode_entry` admission narrow (run `/pgas:mode-entry-lint`)
- [ ] FM4 — every handler-backed raw tool has `createAdapters` override + `syncOutContinuationPolicy.channels` entry
- [ ] FM5 — engine-owned `inputs.query_meta.*` paths still declared in spec.yml schema

## Risks

<!--
  Known risks. If any classifier-denied tool calls were encountered while
  preparing this PR, list them here.
-->

## Classifier-denial reminder

By opening this PR I confirm: no classifier-denied tool calls were
retried with `dangerouslyDisableSandbox: true` or any equivalent
bypass. Any denials encountered are reported in the "Risks" section
above.
