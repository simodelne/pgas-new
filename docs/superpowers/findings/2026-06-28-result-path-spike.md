# Result Path Spike

Date: 2026-06-28

## Question

Does a synthesized stage action with an `action_map.result_path` and no explicit
`tools:` block write the handler return into governed state, while `from_arg`
writes the LLM tool-call argument?

## Test

Temporary test file: `tests/unit/result-path-spike.test.ts` (not retained).

The test defined a minimal in-memory PGAS program loaded through
`@simodelne/pgas-server/plugin.js` and driven by
`@simodelne/pgas-server/testing.js`.

It declared two actions on a Sync output channel:

- `capture_from_arg` with mutation
  `{ op: MSet, path: stage.from_arg_value, from_arg: result_json }`
- `capture_result_path` with
  `result_path: stage.result_path_value` and no explicit `tools:` block

Both handlers returned `{ source: "handler_return", ... }`; both tool calls
passed payload args `{ result_json: { source: "tool_call_arg", ... } }`.

## Result

Command:

```bash
npx vitest run --config tests/vitest.config.ts tests/unit/result-path-spike.test.ts
```

Output:

```text
Test Files  1 passed (1)
Tests  1 passed (1)
```

Assertions:

- `stage.from_arg_value` equaled the tool-call arg:
  `{ source: "tool_call_arg", digest: "arg-from-arg" }`
- `stage.result_path_value` equaled the handler return:
  `{ source: "handler_return", digest: "handler-result-path" }`

## Wrapper Pattern Confirmed

For synthesized compute/external stage actions:

```yaml
channels:
  stage_output: { direction: Out, sync: Sync }

action_map:
  complete_stage:
    result_path: stage.result_json
    mutations:
      - { op: MSet, path: stage.done, value: true }
    channel: stage_output
```

Register the handler through `createProgramAdapters(spec, ctx, handlers)`. The
handler's returned value lands at `stage.result_json`. Do not also mutate the
same path with `from_arg`; use `from_arg` only for runtime LLM-reasoning stages
where the tool-call argument is the intended source of truth.
