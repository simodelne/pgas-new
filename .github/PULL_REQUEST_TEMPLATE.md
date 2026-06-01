<!--
  PR template for claude-pgas-plugin. Mirrors pgas/.github/PULL_REQUEST_TEMPLATE.md
  in structure, but the FM-closure + Alloy sections do not apply here.
-->

## Brief

<!--
  If this PR was opened by a sub-agent under the orchestrator pattern,
  paste the brief you were given here, verbatim. For direct commits by
  the curator/orchestrator, write "N/A — direct orchestrator commit".
-->

## Summary

<!--
  1-3 bullets. What changed and why.
-->

## Test plan

- [ ] `bash tests/plugin-manifest.test.sh` passes
- [ ] `bash tests/template-render.test.sh` passes
- [ ] CI green on this branch
- [ ] (if commands/skills changed) manual: linked plugin into Claude Code, verified commands/skills appear

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
