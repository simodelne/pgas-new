# Engine Request: Preserve Current Mode on Failed and Aborted Sessions

## Evidence

Section 10 Round 10 reported failed/aborted sessions as `mode:
pr_graduation` even though the failure occurred in `intake_intelligence`.

Examples:

- `.uat/session-logs/pgas-new-1782162350561/session-log.ndjson:38-45`
  - `round_execution_failed` and `trigger_failed` show
    `mode: "intake_intelligence"`.
  - Immediately afterward, `status_changed`, `status_emit`, and
    `session:status` show `mode: "pr_graduation"`.
- `.uat/session-logs/pgas-new-1782162117002/session-log.ndjson:82-89`
  - `abort_cascade_state_saved` shows state mode
    `intake_intelligence`.
  - `status_changed`, `status_emit`, `session:status`, and
    `abort_completed` show `mode: "pr_graduation"`.

## Engine Boundary

The foundry REPL and status views only echo the session envelope/list rows
returned by `@simodelne/pgas-server`; they do not compute this mode locally.

Relevant bundle locations in `@simodelne/pgas-server@2.13.1`:

- `node_modules/@simodelne/pgas-server/dist-bundle/plugin.mjs:18740-18847`
- `node_modules/@simodelne/pgas-server/dist-bundle/plugin.mjs:18855-18883`
- `node_modules/@simodelne/pgas-server/dist-bundle/plugin.mjs:21980-22155`

Root cause in the installed engine:

```js
if (isTerminal(status)) {
  const terminalModes = resolved?.entry.spec.terminal ?? [];
  const preferredTerminalMode = terminalModes.length > 0 ? terminalModes[0] : null;
  ...
  if (preferredTerminalMode && !terminalModes.includes(nextState.mode)) {
    nextState.mode = preferredTerminalMode;
  }
}
```

For `pgas-new`, `spec.terminal[0]` is `pr_graduation`. `setStatus(...,
"Failed" | "Aborted", ...)` therefore rewrites any non-terminal current mode to
`pr_graduation` before status events are emitted and before terminal state is
persisted.

## Requested Behavior

Terminal status should not imply terminal mode for failure/abort paths.

Recommended split:

- `Completed`: terminal-mode normalization can remain valid when the program
  actually reached a terminal mode or a terminal-mode late-input path.
- `Failed` and `Aborted`: preserve `record.state.mode` / live session mode as
  the current failure/abort point.
- Status events should include the preserved current mode so status/history
  assertions can distinguish an intake failure from successful graduation.

If a terminal status needs a compact terminal marker, add a separate field such
as `terminalStatusMode` instead of overwriting `state.mode`.
