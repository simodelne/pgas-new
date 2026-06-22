# Engine Request: Native Tool Enforcement for Foundry OpenAI-Compatible Runs

## Evidence

Section 10 Round 10 still produced legacy JSON content instead of native
`tool_calls`:

- `.uat/session-logs/pgas-new-1782162350561/session-log.ndjson:22-23`
- `hadToolCalls=false`
- `actionCount=4`
- `actionNames=["record_program_target","record_program_target","record_program_target","record_program_target"]`

The Phase 3.18 payload test verifies the foundry bootstrap can remove
`response_format` from actual OpenAI-compatible request bodies when
`PGAS_OPENAI_DISABLE_JSON_RESPONSE_FORMAT=1` is applied before the provider
call. That means the remaining `hadToolCalls=false` problem is not explained
by `response_format` alone.

## Engine Findings

Installed package: `@simodelne/pgas-server@2.13.1`.

Relevant bundle locations:

- `node_modules/@simodelne/pgas-server/dist-bundle/plugin.mjs:10291-10310`
- `node_modules/@simodelne/pgas-server/dist-bundle/_shared-types.d.ts:5267-5382`

Findings:

- The OpenAI-compatible payload builder only sets `tool_choice = "auto"` when
  active tools are present.
- `PgasServerConfig.drivers.unified` exposes no public `tool_choice` override.
- The default foundry server bootstrap uses the JSON author path, not
  `authorMode: "unified"`, so the captured default OpenAI-compatible payload
  may contain no native `tools` declaration at all.
- `authorMode: "unified"` requires a caller-supplied
  `(messages, tools) => Promise<CompletionResponse>` completer. The package
  exports `createProviderHandles`, but that returns the legacy prompt-string
  author handle, not a reusable OpenAI-compatible unified completer.
- Direct zero-mutation output actions such as `ask_design_question` cannot
  currently declare required native-tool parameters. The direct `action_map`
  path accepts `arg_descriptions` but no `arg_schema`; explicit `tools:`
  declarations desugar to `invoke_tool_<name>` and are not suitable for direct
  vocabulary actions.

## Requested Engine API

Expose a supported way for a program/server bootstrap to force native tool
calls on OpenAI-compatible providers:

```ts
createPgasServer({
  drivers: {
    authorMode: 'unified',
    unified: {
      toolChoice: 'required',
    },
  },
});
```

or expose a reusable OpenAI-compatible unified completer that accepts a
`toolChoice` option and preserves the existing env-based provider behavior.

Also allow direct zero-mutation `action_map` output actions to declare an
LLM-facing JSON schema without creating state mutations or desugaring to
`invoke_tool_*`.

## Interim Foundry Workaround

- `PGAS_OPENAI_DISABLE_JSON_RESPONSE_FORMAT=1` remains defaulted before
  provider calls.
- Intake prompt/guidance now says every round must emit one native tool call
  and uses `ask_design_question` for Q1-Q6 question pauses.
- The prompt explicitly states that free-form assistant content is parsed as an
  invalid empty-name action.
