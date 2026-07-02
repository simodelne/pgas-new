# Real LLM-Reasoning Stage Synthesis — Design Spec

- **Date:** 2026-07-02
- **Status:** Draft for owner review — Codex-validated **SOLID-WITH-FIXES** (fixes folded in 2026-07-02)
- **Owner:** Simone
- **Baseline:** pgas-new v3.9.2 (`main` @ `b6ae256a`), engine `@simodelne/pgas-server` 2.16.0
- **Predecessor:** `docs/superpowers/specs/2026-06-28-foundry-domain-synthesis-design.md`
  (which deliberately deferred llm-reasoning stages: "no body; tune prompt/schema", §4).
  This spec is that deferred work.

## 0. Independent validation (Codex, 2026-07-02)

Codex reviewed this spec against the actual engine + synthesizer code. **Verdict: SOLID-WITH-FIXES** — the weave points are real and feasible, and every assumption in §12 was **validated** against source (scripted payloads feed `from_arg`; GKType applies on the scripted path *before* `runTypeGate`; GKType is nominal `Map<Path,TypeName>` so enum/composite agreement is not engine-enforceable; the post-approval spec-sha drift is technically allowed by `gates.ts:239`; all named functions/paths exist). Codex's four corrections are folded into this revision:

1. **Enforcement language tightened** — §2.1(b): the schema is engine-enforced at the *type* level only (nominal GKType); enum/required-key/composite agreement is gate+prompt-enforced (already documented in §5.3, §12.2–12.3).
2. **Smoke channel fixed** — §6.7: the generated smoke effect must be emitted on the action's declared channel (`widget_output`), not the helper's `stage_output` default, or the observability envelope is unreachable.
3. **Item-template literal anchors** — §5.3: `itemTemplateMatcher` treats every `<...>` as a wildcard, so literal prefixes (e.g. the stage slug) must be spelled out; `assertReasoningContract` enforces this.
4. **Fallback-vs-hard-fail default → OPEN OWNER DECISION** — §12.8: Codex flags the §5.5 "fallback unless `REQUIRE_LLM=1`" as a real policy change from body-synthesis's hard-fail-only; it prefers inverting the default (hard-fail on configured-provider failure; `ALLOW_..._FALLBACK=1` to opt in). **Requires Simone's decision before implementation.**

## 1. Problem (verified against code)

The v3.9.x foundry synthesizes real, behaviorally-gated bodies for `pure-compute`
and `external-adapter` stages, but `llm-reasoning` stages — the ones the classifier
tags as *the stage IS judgment* (`src/foundry-program/stage-classifier.ts:43-55`
`LLM_REASONING_TERMS`: analysis/classify/critique/draft/judge/narrative/reason/
recommend/review/summarize/summary; branch at `:103-109`) — are hollow at every
layer:

1. **A placeholder body is written but never executed.**
   `renderLlmReasoningStageBody(stage)` (`src/foundry-program/domain-synthesis.ts:662-678`)
   emits a `runStage` that returns
   `{ status: '<stage>_reasoning_ready', ... }` / `['<stage>:reasoning_ready']`.
   `synthesizeDomainLogic` stores it into `stage_sources[stage]`
   (`domain-synthesis.ts:96-108`) and `branch_write` writes it to
   `src/programs/<slug>/stages/<stage>.ts`
   (`src/pgas-new/artifact-plan.ts:270-288`,
   `requireAcceptedStageSources` at `src/foundry-program/handlers.ts:1525-1532`).
   But the generated handlers never import it: `renderHandlersSource` filters
   llm-reasoning stages out of `bodyActions`/`stageImports`
   (`src/foundry-program/synthesizer.ts:703-708`), and the llm-reasoning action
   handler (`synthesizer.ts:725-739`) just echoes the engine LLM's tool-call args
   (`kind: 'llm_reasoning_stage_output'`, reading `result_json`/`items_json` via
   `resolveDomainValue`). The file is dead code that *implies* deterministic
   execution which never happens.

2. **Governed state comes from unconstrained tool-call args.** The stage action's
   `action_map` entry (built by `actionMapEntryFor`, `synthesizer.ts:612-641`)
   writes `<stage>.result_json` / `<stage>.items_json` via
   `{ op: MSet, from_arg: result_json|items_json }`. Per the engine contract
   (`node_modules/@simodelne/pgas-server/dist-bundle/_shared-types.d.ts:571-588`)
   `from_arg` resolves the value from the **LLM tool-call argument** — correct for
   this archetype (the model IS the logic; see the state-write contract memory and
   the 06-28 spec §4) — but the only runtime constraint is the declared schema type
   `string` at those paths (`synthesizer.ts:289-303`), i.e. GKType
   (`_shared-types.d.ts:106`, schema is `Map<Path, TypeName>` at `:1023`) checks
   "is a string" and nothing else.

3. **The mode prompt gives the runtime model nothing to reason with.**
   `promptForStage` (`synthesizer.ts:1175-1183`, invoked at `:243-245`) emits
   `"Perform the <stage> stage for <Name>."` unless the author supplied a
   `domain_spec`. Concrete evidence — the v3.9.1 live-graduated program
   `/home/simone/pgas-new-smoke-runs/risk-acceptance-memo-v391/src/programs/risk-acceptance-memo/specs.yml`:
   - `prompts.recommendation: Perform the recommendation stage for Risk Acceptance Memo.` (line 331)
   - `advance_recommendation_to_review.arg_descriptions.result_json: JSON string result for the recommendation LLM reasoning stage.` (lines 389-391)
   - `schema: recommendation.result_json: string` (line 544)

   No reasoning instructions, no field inventory, no enums, no example. Whatever
   JSON the runtime model improvises becomes the program's judgment record.

4. **No gate ever looks at reasoning quality or shape.** The synthesis audit
   records `behavioral_gate: 'not_applicable'` for every llm-reasoning stage
   (`domain-synthesis.ts:103`), visible in all three golden fixtures
   (`tests/fixtures/domain-synthesis-goldens/*.json` — `editorial_review`,
   `remediation_summary`, `brief_summary` all carry `not_applicable`).

Net effect: a generated program graduates end-to-end (v3.9.1 standalone proof)
while its recommend/review/summarize stages produce structurally arbitrary output.

## 2. Locked decisions (owner — do not relitigate)

- **D1 — Execution model is PGAS-native.** Reasoning stays in the generated
  program's own engine author-LLM at runtime. The foundry synthesizes a real
  reasoning prompt + a structured `result_json` output contract for the stage's
  mode, enforced through the stage action's synthesized tool schema
  (`from_arg` fields + GKType). No `runStage`-body provider call, no
  `StageRuntime.llm` usage.
- **D2 — Contract source is build-time meta-LLM synthesis.** At `domain_synthesis`
  time, one meta-LLM call per reasoning stage designs
  `{reasoning_prompt, result schema, items shape, canned example}`, reusing the
  existing `domain-synthesis` provider infrastructure: injected generator,
  content-addressed `cacheDir` cache, retry-then-fail loop,
  `PGAS_DOMAIN_SYNTHESIS_*`-style env knobs, `AbortController` timeout — plus a
  **deterministic fallback** so unit/static/CI/offline runs stay hermetic.

### 2.1 Goal

Every generated llm-reasoning stage carries: (a) a stage-specific reasoning
prompt in the generated `specs.yml`, (b) a typed core output schema whose
per-field runtime *types* are engine-enforced by GKType — nominal only: enum
membership, required-key presence, and composite/field agreement are enforced at
the synthesis gate + prompt layers, not by the engine (see §5.3 and §12.2/§12.3),
(c) a schema-conformant canned example used by the generated smoke test
and by fixture seeding, and (d) a real synthesis-time gate replacing
`behavioral_gate: 'not_applicable'` — proven by a live standalone graduation
drive where a real provider reasons at those stages.

### 2.2 Non-goals

- Runtime provider calls from stage bodies (`StageRuntime.llm` stays a
  deliberate throw; `domain-synthesis.ts` behavioral runtime `:1026-1028`).
- Changing pure-compute / external-adapter body synthesis semantics (their
  prompts pick up one additive sentence about where reasoning outputs live —
  §6.8 — but generation, gating, and `result_path` wiring are untouched).
- Multi-turn or tool-using reasoning at a stage; one action call per hop stays.
- Engine changes. Everything below uses already-published spec surfaces
  (`from_arg`, `arg_descriptions`, `coerce`, schema map, GKType,
  `loadSpecWithPatterns`) — consistent with the CLAUDE.md engine boundary and
  `src/pgas-new/version.ts` `PGAS_SERVER_RUNTIME_IMPORTS`.

## 3. Design overview

```
intake (Q1 purpose, Q3 stages, Q4 transitions, Q5 delegation, Q6 completion)
        │  record_q*_ handlers (src/foundry-program/handlers.ts:628-690)
        ▼
architecture_design: synthesize_program_spec  ──►  generic spec (UNCHANGED; SI-3:
        │   handlers.ts:567-591                    mechanical, no LLM call)
        ▼
scaffold_plan: plan_artifacts (paths unchanged — stages/<stage>.ts kept)
        ▼
domain_synthesis: synthesize_domain_logic (handlers.ts:783-800)
        ├─ NEW (1) synthesizeReasoningContract per llm-reasoning stage
        │         (meta-LLM, cached, deterministic fallback)  §5
        ├─ NEW (2) resynthesizeWithReasoningContracts — deterministic re-weave
        │         of spec_yaml/handlers/contracts/tools/smoke  §6
        ├─ (3) existing pure-compute/external-adapter body loop, now running
        │         against the woven artifact (richer fixture seeds)  §6.8
        └─ (4) contract-record stage sources + audit entries  §6.6, §5.6
        ▼
branch_write → static_verify → smoke_verify → live_verify → rebase_verify → pr_graduation
        ▼
runtime: engine author-LLM reads woven mode prompt/guidance, must emit the
         typed args; GKType + repair_bound enforce; state carries both the
         composite result_json and per-field typed paths.
```

Enforcement is layered, weakest-to-strongest:

| Layer | Mechanism | Strength |
|---|---|---|
| Prompt | woven `prompts.<stage>` + `guidance.<stage>` | advisory |
| Tool schema | synthesized per-arg params + `arg_descriptions` (`_shared-types.d.ts:655-686`) | advisory-but-visible to the model |
| Engine gate | GKType on each typed path `<stage>.result.<field>` + `repair_bound: 2` repair rounds | hard, per call |
| Synthesis gate | contract conformance check on the canned example + woven spec `loadSpecWithPatterns` validation (`synthesizer.ts:1217-1226`) | hard, at build |
| Corpus gate | SOTA oracles + smoke test assert canned/live conformance | hard, in CI/live |

## 4. The reasoning contract (data model)

New types in `src/foundry-program/reasoning-contract.ts`:

```ts
export type ReasoningFieldType = 'string' | 'number' | 'boolean' | 'enum' | 'string_array';

export interface ReasoningField {
  name: string;               // /^[a-z][a-z0-9_]*$/, max 32 chars
  type: ReasoningFieldType;
  description: string;        // non-empty; woven into arg_descriptions
  enum_values?: string[];     // required iff type === 'enum'; 2..8 values
}

export interface ReasoningStageContract {
  contract_version: 'foundry-reasoning-contract-v1';
  stage: string;
  reasoning_prompt: string;   // 200..1600 chars, imperative, stage-specific
  result_schema: {
    fields: ReasoningField[]; // 3..7 required core fields
    allow_extra_fields: true; // composite result_json may carry extras
  };
  items_schema: {
    templates: string[];      // 1..5 '<placeholder>' templates, matcher-compatible
    description: string;      //   with itemTemplateMatcher (domain-synthesis.ts:1378-1389)
  };
  canned_example: {
    result: Record<string, unknown>; // conforms to result_schema (may include extras)
    items: string[];                 // matches items_schema.templates 1:1
  };
  contract_source: 'meta_llm' | 'deterministic_fallback';
}
```

Validation rules (`assertReasoningContract`, hard-thrown, also used as the
repair signal in §5.4):

- `fields` length 3–7; names unique, identifier-shaped, and **not** in the
  reserved set `{result_json, items_json, note, value, stage, query}` nor equal
  to the tail segment of any guard field on the stage's outgoing transitions
  (guard mutations use literal `value: true`, but the engine's `from_arg`
  *default* is the path tail — `_shared-types.d.ts:579-583` — so we exclude the
  tails defensively even though every synthesized mutation sets `from_arg`
  explicitly).
- `type` limited to the five values above because GKType enforcement is nominal:
  the engine schema is `Map<Path, TypeName>` (`_shared-types.d.ts:1023`) with the
  TypeNames the synthesizer already emits (`string`/`number`/`boolean`/`object`/
  `array`, `synthesizer.ts:283-303`). Mapping: `enum → string`,
  `string_array → array`; enum membership and array element types are enforced
  at the synthesis gate + prompt/description layers, *not* by GKType
  (documented limitation, §12).
- `canned_example.result` must contain every core field with the mapped runtime
  type and (for enums) a declared member; `canned_example.items` must match
  `items_schema.templates` positionally via `itemTemplateMatcher`.
- **Literal prefixes in item templates must be spelled out, not `<stage>` (Codex).**
  `itemTemplateMatcher` (`domain-synthesis.ts:1378-1389`) treats *every* `<...>`
  token as a free wildcard, so a template like `<stage>:decision:<decision>` does
  **not** assert the stage literal — any prefix would match. Where a template is
  meant to pin a constant (e.g. the stage slug), emit the literal (`triage:decision:<decision>`).
  `assertReasoningContract` rejects a template whose first segment is a
  `<...>` placeholder when that segment is intended as a literal anchor (the
  meta-prompt is instructed to use the concrete slug, and the deterministic
  fallback already substitutes it).
- Strictness decision: **required core fields, extras allowed.** Contrast with
  the deterministic-stage rule `assertResultJsonSchema`
  (`domain-synthesis.ts:1337-1354`), which demands exact key set + order because
  a deterministic body can guarantee it. A runtime LLM cannot; requiring the
  core and tolerating extras keeps GKType satisfiable while still making the
  judgment record machine-consumable.

## 5. Meta-LLM synthesis — `synthesizeReasoningContract`

Home: new module `src/foundry-program/reasoning-contract.ts` (mirrors
`domain-synthesis.ts` structure; no changes to `stage-classifier.ts`).

### 5.1 API

```ts
export interface ReasoningContractRequest {
  stage: string;
  context: ReasoningStageContext;    // §5.2 inputs, serialized as untrusted JSON
  repair?: { attempt: number; lastError: string };
}
export interface ReasoningContractGenerator {
  (request: ReasoningContractRequest): Promise<string>; // returns JSON text
}
export interface ReasoningContractOptions {
  generator?: ReasoningContractGenerator;
  cacheDir?: string;      // SAME cacheDir the body loop uses
  maxAttempts?: number;   // default 4, mirroring domain-synthesis.ts:83
  providerUrl?: string;   // default PGAS_OPENAI_BASE_URL
  model?: string;         // default PGAS_OPENAI_MODEL ?? PGAS_MODEL
}
export async function synthesizeReasoningContract(
  stage: string,
  artifact: SynthesizedArtifact,
  options: ReasoningContractOptions,
): Promise<ReasoningStageContract>;
```

### 5.2 Meta-prompt inputs (all already available on the artifact)

From `artifact.synthesis_context` (`src/foundry-program/synthesizer-store.ts:1-28`)
and `artifact.stage_classification`:

- program `purpose` (intake **Q1**, `record_q1_purpose`, `handlers.ts:628-632`),
  `program_name`, `program_slug`, `entry_channel` + initial entry path;
- the stage slug (intake **Q3**, `record_q3_stages`, `handlers.ts:642-649`) and
  the classifier `rationale` for the llm-reasoning tag;
- the stage's `delegation` entry (intake **Q5**) — e.g. risk-acceptance-memo's
  `recommendation: { notes: "draft accept, mitigate, or reject recommendation with rationale and acceptance period" }`
  is exactly the domain vocabulary the contract should turn into enum/core fields;
- the stage's `domain_spec` if the author supplied one (normative; the contract
  must embed `produces.result_json` keys as core fields and reuse
  `produces.items_json` templates verbatim);
- prior stages in topological order with their output paths
  (`<prior>.output.result_json` for deterministic stages,
  `<prior>.result_json` / `<prior>.result.<field>` for reasoning stages) so the
  reasoning prompt can direct the runtime model at real inputs;
- the stage's outgoing transitions + guard fields (e.g. `review.approved` vs
  `review.revision_requested`) so the contract can require a decision field
  whose enum values align with the branch the model must then select.

### 5.3 Meta-prompt output instruction

The system message demands **JSON only** (no markdown fences; reuse
`extractCode`-style fence stripping, `domain-synthesis.ts:1577-1580`, adapted
for JSON), matching the `ReasoningStageContract` shape minus
`contract_version`/`contract_source` (stamped by the module). The user message
carries the §5.2 context as `JSON.stringify(...)` labeled *"Untrusted stage
context"* — same prompt-injection posture as `promptForStage`
(`domain-synthesis.ts:651-654`). Field-count, naming, enum-size, and
template-syntax constraints from §4 are stated explicitly so most repairs are
avoided rather than caught.

### 5.4 Provider call, retry, cache

Clone the proven mechanics of `createOpenAiCompatibleBodyGenerator`
(`domain-synthesis.ts:523-581`):

- `POST {providerUrl}/chat/completions`, `temperature: 0`;
- `max_tokens` from **`PGAS_REASONING_CONTRACT_MAX_TOKENS`** (default 1600) and
  timeout from **`PGAS_REASONING_CONTRACT_TIMEOUT_MS`** (default 45_000) via the
  same `positiveIntegerEnv` pattern (`domain-synthesis.ts:583-596`), with an
  `AbortController` exactly as at `:528-570`;
- retry loop: parse JSON → `assertReasoningContract` → on failure re-prompt with
  `repair: { attempt, lastError }` (mirrors `domain-synthesis.ts:181-211`), up
  to `maxAttempts` (default 4);
- cache: same `cacheDir`, content-addressed like `cacheKeyFor`
  (`domain-synthesis.ts:1519-1528`) but with its own version string:
  `sha256(['foundry-reasoning-contract-v1', stage, JSON.stringify(context), model, providerUrl].join('\n---\n'))`,
  file `<key>.reasoning.json` (distinct suffix so body-cache readers'
  `readCache` shape check, `:1530-1545`, never collides). Cache record:
  `{ contract, contract_hash, contract_source }`. Cache hits skip the provider
  entirely — identical replay semantics to the SOTA body-cache
  (`tests/sota/harness.test.ts:106-123`).

### 5.5 Deterministic fallback + hard-fail semantics

Precedence per stage:

1. **cache hit** → use cached contract (`cache_hit: true` in audit).
2. **provider configured** (generator injected, or `providerUrl` + `model`
   resolvable) → meta-LLM with retries. After `maxAttempts` failures:
   - if **`PGAS_REASONING_CONTRACT_REQUIRE_LLM=1`** → **hard-fail** the
     `synthesize_domain_logic` action with
     `reasoning contract synthesis failed for stage <stage> after <N> attempts; last error: <e>`
     (same loud shape as `domain-synthesis.ts:214-216`; the foundry surfaces it
     through the REPL and `domain_synthesis` does not complete). Live
     graduation drives set this flag — a graduated program must never carry a
     silent fallback contract.
   - otherwise → fall through to (3) **with the failure recorded** in the audit
     (`contract_source: 'deterministic_fallback'`, `fallback_reason: <last error>`)
     and a REPL-visible warning line. Degradation is explicit, never silent.
3. **no provider configured** (the hermetic unit/static/CI path — today these
   paths run `synthesizeDomainLogic` with an injected body generator and no
   provider) → `deriveFallbackReasoningContract(stage, artifact)`:
   - if the stage has a `domain_spec`: core fields = `produces.result_json`
     keys with types inferred from the sample values (`typeof` → §4 mapping),
     items templates = `produces.items_json` verbatim, prompt built from
     `rules` + `invariants`;
   - else the generic-but-honest default: fields
     `decision` (enum derived from outgoing guard-field tails when ≥2 outgoing
     transitions exist, e.g. `['approved','revision_requested','blocked']` for
     the risk-memo `review` stage; otherwise `['proceed','blocked']`),
     `summary` (string), `rationale` (string), `confidence`
     (enum `['low','medium','high']`), `key_points` (string_array); items
     templates `['<stage>:decision:<decision>', '<stage>:confidence:<confidence>']`;
     prompt composed from purpose + delegation notes + prior-stage paths.
   Pure function of the artifact — byte-stable across runs, which is what keeps
   the golden fixtures (§10.2) deterministic.

### 5.6 Audit

The per-stage audit entry (today `domain-synthesis.ts:99-107`) becomes:

```
{ stage, archetype: 'llm-reasoning',
  behavioral_gate: 'reasoning_contract_conformance',   // replaces 'not_applicable'
  contract_source, contract_hash, fallback_reason?,
  attempts, cache_hit, body_hash }                      // body = contract-record module, §6.6
```

`behavioral_gate: 'reasoning_contract_conformance'` asserts, deterministically:
the contract passed `assertReasoningContract` (which includes canned-example
conformance) **and** the woven spec (§6) still loads through
`validateSynthesizedSpec`/`loadSpecWithPatterns`.

## 6. Weaving the contract into the generated program

Deterministic step, preserving SI-3 (LLM produces judgment as data; code emits
YAML). Implementation: `SynthesizeProgramSpecOptions`
(`synthesizer.ts:60-63`) gains
`reasoningContracts?: Record<string, ReasoningStageContract>`, and synthesizer.ts
exports:

```ts
export function resynthesizeWithReasoningContracts(
  artifact: SynthesizedArtifact,
  contracts: Record<string, ReasoningStageContract>,
  options: SynthesizeProgramSpecOptions,
): SynthesizedSpec;
```

which rebuilds the domain record from `artifact.synthesis_context`
(`'program.slug'`, `'program.name'`, `'intake.purpose'`,
`'intake.entry_channel'`, `'intake.stages_json': JSON.stringify(stages)`, etc. —
the context holds every input `synthesizeProgramSpecFromDomain` consumes,
`synthesizer.ts:99-107`) and re-runs `synthesizeProgramSpecFromDomain` with the
contracts. `entry_channel` is already normalized, and
`normalizePgasChannelId` is idempotent on its own output (`synthesizer.ts:1135-1153`),
so the re-run is byte-identical to the first run wherever a contract doesn't
apply. When `options.reasoningContracts` is absent (the `architecture_design`
call at `handlers.ts:570`), behavior is bit-for-bit today's output.

Per-point changes when a contract exists for stage `S`:

### 6.1 Mode prompt — `promptForStage` (`synthesizer.ts:1175-1183`, applied at `:243-245`)

Replace the generic base with:

```
<contract.reasoning_prompt>
Return your reasoning through the stage action's arguments. result_json must be
a JSON object containing at least: <field: type/enum list>. Additional keys are
allowed. items_json must be a JSON array of strings matching: <templates>.
```

If a `domain_spec` exists, the current normative-domain-spec suffix
(`:1177-1182`) is still appended after the contract prompt.

### 6.2 Mode guidance — `guidanceFor` (`synthesizer.ts:1185-1207`, applied at `:305`)

Append to `guidance[S]`: one line per core field
(`name (type[, one of: …]): description`), the items templates, and
`Populate every core argument; the composite result_json must agree with the per-field arguments.`
Existing base/delegation/domain-spec lines are preserved.

### 6.3 Action tool schema — `actionMapEntryFor` (`synthesizer.ts:612-641`)

For **every** action whose `source === S` (single-hop, branch, and `*_to_blocked`
variants — all carry the reasoning mutations today, cf. risk-memo specs.yml
lines 387-402 and 466-497), keep the existing
`result_json`/`items_json` `from_arg` mutations and **add, per core field**:

```yaml
- op: MSet
  path: <S>.result.<field>
  value: null            # sentinel; engine resolves via from_arg
  from_arg: <field>
```

`from_arg` explicitly names the arg (multi-arg mutations are first-class:
`_shared-types.d.ts:571-588`). `arg_descriptions` gains one entry per field from
`ReasoningField.description` (enums inlined: `One of: a | b | c.`) — this is the
engine's documented lever for shaping the synthesized tool parameter
(`_shared-types.d.ts:665-686`). The existing `result_json`/`items_json`
descriptions (`:633-637`) are rewritten to enumerate the core keys.
No `coerce:` in v1 (available per-mutation at `_shared-types.d.ts:589-625` as a
future drift lever; §12).

### 6.4 State schema — the loop at `synthesizer.ts:289-303`

For llm-reasoning stage `S` with a contract, in addition to the current
`<S>.result_json: string` / `<S>.items_json: string`:

```
<S>.result: object
<S>.result.<field>: string|number|boolean|array   # §4 mapping
```

This is the object-parent + typed-children pattern already used for
deterministic stages (`<stage>.output.*`, risk-memo specs.yml lines 540-543).
**This is the hard runtime gate**: GKType validates each arg-supplied value
against the declared TypeName before the mutation lands.

### 6.5 Projection — `outputProjectionFields` (`synthesizer.ts:605-610`)

llm-reasoning branch returns
`[`${S}.result_json`, `${S}.items_json`, `${S}.result`]` so the stage's own
mode, downstream intermediate modes (`accumulatedOutputFieldsBefore`,
`:197-205`), and terminal modes project the typed record too.

### 6.6 The placeholder body — **decision: replace, do not keep a fake `runStage`**

`renderLlmReasoningStageBody` is deleted. In its place `synthesizeDomainLogic`
stores, at the same planned path `src/programs/<slug>/stages/<S>.ts`
(so `artifact-plan.ts:270-288` and `assertAllPlannedArtifactsWritten` need no
path changes and `requireAcceptedStageSources` stays satisfied), a
**contract-record module**:

```ts
// Runtime locus: this stage executes inside the program's engine author-LLM.
// This module is the first-class record of the reasoning contract that the
// woven specs.yml (prompt, arg schema, GKType-typed state paths) enforces.
export const reasoningContract = { ...contract } as const;
```

Justification: a dead `runStage` misrepresents the execution locus (the exact
"implying intelligence/determinism where there is none" failure mode the repo's
reporting rules exist to prevent), while the contract module makes the generated
artifact a first-class, typecheckable record — satisfying the CLAUDE.md
invariant *"Generated artifacts are first-class records, not incidental side
effects."* Nothing imports llm-reasoning stage files (`synthesizer.ts:703-708`),
so the swap is compile-safe; the generated repo's `npm run typecheck`
(exercised by `tests/pgas-new-static.test.sh`) compiles it as a plain const
module.

### 6.7 `contracts_ts`, `tools_ts`, handlers, smoke test

- `renderContractsSource` (`synthesizer.ts:808-953`) additionally embeds
  `export const stageReasoningContracts = {...} as Record<string, ReasoningStageContract>;`
  next to `stageDomainSpecs` (`:870`), with the interface declared locally in
  the generated `contracts.ts` (generated code imports no foundry modules).
- `renderToolsSource` (`synthesizer.ts:778-806`): llm-reasoning metadata entries
  gain `result_fields: [<field names>]` and `result_record_path: '<S>.result'`.
- `renderHandlersSource` llm-reasoning branch (`synthesizer.ts:725-739`):
  unchanged in its state role (state is written by `from_arg` mutations, not the
  handler return — confirmed contract). Additive, observability-only change: the
  handler also resolves each core field
  (`resolveDomainValue(payload, '<field>', null)`) and returns them under
  `fields`, plus `contract_conformant: boolean` computed by parsing `result_json`
  and checking core-field presence/agreement. This lands in the action's
  `widget_output` envelope for session logs / SOTA judging; a mismatch does
  **not** throw (hard enforcement stays with GKType + the gates in §10).
- `renderSmokeTestSource` llm-reasoning branch (`synthesizer.ts:966-971`):
  instead of the hardcoded `{ stage, status: 'reasoned' }`, emit the contract's
  canned example —
  `effect(name, { result_json: JSON.stringify(canned_example.result), items_json: JSON.stringify(canned_example.items), ...cannedFieldArgs })`
  where `cannedFieldArgs` maps each core field to `canned_example.result[field]`.
  **Channel selection (Codex):** the generic smoke helper defaults every
  non-`begin_work` effect to `stage_output` (`synthesizer.ts:1007`), but the
  llm-reasoning `action_map` uses `widget_output` (`synthesizer.ts:640`). The
  llm-reasoning branch therefore MUST emit the effect on the action's declared
  channel — pass `channel: 'widget_output'` explicitly — otherwise the
  `widget_output` conformance envelope described above is never produced and the
  SOTA judge / session-log observability path is unreachable. The generated smoke
  helper gains one parameter: the action's channel from the topology, defaulting
  to `stage_output` for non-reasoning stages (no behavior change there).
  Evidence that scripted payload keys feed `from_arg` mutations on this path:
  today's generated smoke passes `result_json` in the scripted payload and the
  SOTA scorer subsequently reads `<stage>.result_json` out of the domain
  (`tests/sota/score.ts:383-395` payload injection, `:404-413` domain read) —
  the same mechanism carries the new per-field args (inference from observed
  behavior; §12 keeps a harness spike to confirm GKType parity on the scripted
  path).

### 6.8 Interaction with the deterministic body loop (`domain-synthesis.ts`)

Ordering inside `synthesizeDomainLogic`: contracts + re-weave run **first**, so
the pure-compute/external-adapter loop generates against the woven artifact
(`artifact.spec_yaml` is embedded in every body prompt, `:652-653`). Additive
changes:

- `promptForStage` line `:640` ("Prior LLM reasoning stage outputs are stored as
  strings at `input.domain['<stage>.result_json']`…") gains: *"and as typed
  fields at `input.domain['<stage>.result.<field>']`; prefer the typed fields."*
- `seedPriorStageOutputs` (`:1071-1129`): when a reasoning contract exists for a
  prior stage referenced by `domain_spec.reads`, seed
  `'<stage>.result_json'` with `canned_example.result` and
  `'<stage>.result.<field>'` entries with the canned values, instead of the
  current generic `sampleBehaviorValue` synthesis — behavioral fixtures then
  exercise schema-realistic shapes.
- `SYNTHESIS_VERSION` (`domain-synthesis.ts:9`) bumps to
  `'foundry-domain-synthesis-v6'`; combined with the prompt delta this rotates
  every body cache key (`cacheKeyFor` includes prompt + version), which is the
  intended, precedented invalidation (cf. commit `54da90e4`).

## 7. End-to-end data flow (worked example: risk-memo `recommendation`)

1. **Intake:** Q1 purpose "…drafts a professional risk acceptance memo…", Q3
   stage `recommendation`, Q5 delegation notes "draft accept, mitigate, or
   reject recommendation with rationale and acceptance period".
2. **Classifier:** `recommendation` → `llm-reasoning`
   (`stage-classifier.ts:103-109`, term `recommend`).
3. **Contract synthesis:** meta-LLM returns e.g. fields
   `recommendation (enum: accept|mitigate|reject)`, `rationale (string)`,
   `acceptance_period_days (number)`, `residual_risk_summary (string)`,
   `confidence (enum: low|medium|high)`; items
   `['recommendation:<recommendation>', 'confidence:<confidence>']`; a canned
   example; a 4–8-sentence reasoning prompt grounded in
   `risk_assessment.output.result_json`.
4. **Weave:** `prompts.recommendation` becomes the reasoning prompt;
   `advance_recommendation_to_review` (and `_to_blocked`) gain five typed
   `from_arg` mutations + arg descriptions; schema gains
   `recommendation.result.recommendation: string` … etc.; projection, smoke,
   contracts.ts, stage record updated.
5. **Runtime:** the engine author-LLM in mode `recommendation` reads the woven
   prompt/guidance, calls the action with all seven args; GKType validates the
   five typed paths; on a bad arg the engine's repair loop
   (`repair_bound: 2`, generated specs.yml line 556) re-elicits; on exhaustion
   the declared `fallback` (`channel: widget_output, payload: {ok: false}`,
   lines 557-560) fires and the mode does not advance — a visible stall, not a
   silent junk write.
6. **State:** `recommendation.result_json` (full record) +
   `recommendation.result.*` (typed core) + `recommendation.items_json`;
   downstream `review` reasoning prompt and the `delivery` pure-compute body
   consume the typed paths.

## 8. Error handling summary

| Failure | Where | Behavior |
|---|---|---|
| meta-LLM timeout/HTTP/parse/shape error | synthesis | retry ≤ `maxAttempts` with `repair` context; then fallback-with-audit or hard-fail per §5.5 |
| cache record unreadable/mismatched | synthesis | treated as miss (same posture as `readCache`, `domain-synthesis.ts:1530-1545`) |
| contract fails `assertReasoningContract` after fallback | synthesis | hard-fail (fallback is code we own; its failure is a foundry bug, never shippable) |
| woven spec fails `loadSpecWithPatterns` | synthesis | hard-fail in `validateSynthesizedSpec` (`synthesizer.ts:1217-1226`) — malformed weave cannot reach `branch_write` |
| runtime model emits wrong-typed arg | runtime | GKType rejects → engine repair rounds (`repair_bound: 2`) → declared `fallback` payload; no partial typed write |
| runtime model emits valid types but off-enum / composite-vs-field mismatch | runtime | lands (GKType is nominal); surfaced by handler `contract_conformant: false` envelope + SOTA oracle/live-UAT assertions; §12 lists enum-hardening options |

## 9. Foundry-mode impact

None. `synthesize_domain_logic` already owns LLM-backed synthesis inside the
`domain_synthesis` mode (`src/foundry-program/specs.yml` modes list;
`handlers.ts:783-800`); the contract calls ride the same action. The stored
artifact is updated via the existing `putSynthesizedArtifact` flow, and
`write_scaffold_artifacts` (`handlers.ts:840-884`) already writes whatever the
store holds, so the woven `spec_yaml` flows to disk with zero handler-topology
change. The `domain_synthesis` action result gains `spec_sha256_before/after`
so the re-weave is visible in the audit (the sha returned by
`synthesize_program_spec` at `handlers.ts:589` is informational; no gate pins it
— verified: `sha256` does not appear in `src/pgas-new/gates.ts` and its three
occurrences in `handlers.ts` are all return-payload fields).

## 10. Testing & verification

### 10.1 Hermetic unit coverage (new `tests/unit/reasoning-contract.test.ts`)

- `assertReasoningContract` accept/reject table (field counts, reserved names,
  enum bounds, canned-example conformance, template matching).
- Injected `ReasoningContractGenerator` (the `domain-synthesis-golden.test.ts:44-52`
  injection pattern): happy path, repair-then-accept, exhaust-then-fallback
  (audit carries `fallback_reason`), exhaust-with-`REQUIRE_LLM`-then-throw.
- Cache round trip: second call with same inputs never invokes the generator;
  key rotates when purpose/delegation/model/providerUrl change.
- `deriveFallbackReasoningContract` determinism (double-run equality) + the
  guard-field-derived enum for a branching stage.
- Weave unit tests in `tests/unit/synthesizer*.test.ts`: given a fixed contract,
  assert exact woven `prompts`, `action_map` mutations/arg_descriptions,
  `schema`, projection entries, and that a no-contract call is byte-identical to
  today's output.

### 10.2 Golden fixtures — regeneration required (mechanism explicit)

All three goldens contain one llm-reasoning stage each (`editorial_review`,
`remediation_summary`, `brief_summary`) whose audits currently pin
`behavioral_gate: 'not_applicable'`; `spec_yaml`, `stage_body_hashes`, and
`audit` all change. Mechanism (precedent: commit `54da90e4`): the golden test's
`buildGolden` gains an injected deterministic `reasoningContractGenerator` (two
fixtures) and one fixture deliberately exercising the deterministic fallback
path (no generator) so both sources are regression-locked; rewrite
`tests/fixtures/domain-synthesis-goldens/*.json` from a one-off run of
`buildGolden`, review the diff by hand, commit.

### 10.3 The reasoning behavioral gate becomes real

Audit assertion in `tests/unit/domain-synthesis.test.ts`: no llm-reasoning audit
entry may carry `behavioral_gate: 'not_applicable'` anymore; expected value
`'reasoning_contract_conformance'` with `contract_source` + `contract_hash`.

### 10.4 SOTA corpus + `fee-calculator` replay — regeneration required

- `tests/sota/fixtures/body-cache/fee-calculator/*.json` keys rotate
  (SYNTHESIS_VERSION bump + prompt delta change `cacheKeyFor` inputs even though
  fee-calculator has **no** llm stages — its `meta.json` `llm_stages: []`).
  Mechanism: rerun the harness live
  (`PGAS_LIVE_SYNTH=1 npm run sota:harness -- --slug fee-calculator --cache-dir tests/sota/fixtures/body-cache/fee-calculator`,
  cf. `requireLiveSynthConfig`, `tests/sota/harness.ts:88-103`) against
  `qwen36-27b @ http://100.100.74.6:8000/v1`, then re-run the hermetic replay
  test (`harness.test.ts:106-123`) to prove provider-free reproduction.
- Benchmarks with llm stages (e.g. `brief-summarizer`, `risk-router`): input
  fixtures' `llm_outputs.<stage>` payloads (`score.ts:383-395`) gain the
  per-field args alongside `result_json`/`items_json`; a checked-in
  reasoning-contract cache (`tests/sota/fixtures/contract-cache/<slug>/`) keeps
  the corpus hermetic; oracles gain `<stage>.result.<field>` assertions.

### 10.5 Static + smoke

`npm run typecheck`, `npm run test:static` stay green with no provider: the
foundry path uses the deterministic fallback (or injected generators), the
generated scaffold typechecks the contract-record modules, and the generated
smoke test drives canned examples through the real engine harness — which is
precisely the new schema-conformance check running under CI.

### 10.6 Live acceptance evidence (release gate, per the v3 UAT contract)

A fresh standalone graduation drive in the shape of the v3.9.1 proof
(`/home/simone/pgas-new-smoke-runs/risk-acceptance-memo-v391`), same
risk-acceptance-memo mandate, with `PGAS_REASONING_CONTRACT_REQUIRE_LLM=1` and
the real provider (`qwen36-27b @ 100.100.74.6:8000`). Acceptance evidence, all
captured into the run directory + graduation audit:

1. `domain_synthesis` audit shows every llm-reasoning stage with
   `contract_source: 'meta_llm'`, `behavioral_gate: 'reasoning_contract_conformance'`.
2. Generated `specs.yml` diff vs the v3.9.1 baseline shows stage-specific
   reasoning prompts and typed `<stage>.result.*` schema (no
   "Perform the <stage> stage for …" line for reasoning stages).
3. A live session snapshot where `recommendation.result.*` and
   `review.result.*` are populated with type-valid, enum-valid values, the
   composite `result_json` parses and contains the core fields, and **no**
   `fallback` payload (`ok: false`) appears in the transcript.
4. The generated program's full ladder (install, typecheck, generated tests,
   live provider round) passes and the PR graduates.

## 11. Backward compatibility & rollout

- **Blast radius:** every generated program containing a reasoning stage gets a
  different `specs.yml`, `handlers.ts`, `contracts.ts`, `tools.ts`, smoke test,
  and stage record; all §10.2/§10.4 fixtures regenerate. Existing *already
  graduated* programs are untouched (the foundry regenerates per run; there is
  no in-place upgrade surface).
- **State compatibility:** `<stage>.result_json`/`<stage>.items_json` paths,
  the `llm_reasoning_stage_output` handler kind, and the `widget_output`
  channel are all retained, so every existing consumer of reasoning state
  (SOTA `collectStageOutputs`, `score.ts:404-413`; body prompts,
  `domain-synthesis.ts:640`; projections) keeps working before its optional
  upgrade to the typed paths.
- **Recommendation: ship directly, no feature flag; bump MINOR → v3.10.0.**
  Justification: (a) a flag would preserve the hollow path as a live product
  surface — exactly the "merged-but-not-invoked" split the repo's no-bullshit
  rules exist to kill, and the flagged-off variant would fail the new §10.3
  audit gate anyway; (b) the generated-program *state contract* is additive
  (new paths, kept paths), so MINOR per the repo's versioning practice
  (v3.9.0 was "MINOR — graduation hardening"); (c) hermeticity concerns are
  solved by the deterministic fallback + injected generators, not by a flag.
  The only env switches are behavioral knobs
  (`PGAS_REASONING_CONTRACT_TIMEOUT_MS`, `..._MAX_TOKENS`, `..._REQUIRE_LLM`),
  mirroring the existing `PGAS_DOMAIN_SYNTHESIS_*` pair.

## 12. Risks & open questions (with mitigations)

1. **Arg-count pressure on 27B-class runtime models.** A reasoning action now
   synthesizes ~7–9 tool params (2 composite + 3–7 fields + guard-free). Risk:
   omitted args. Mitigations: hard cap of 7 core fields; explicit
   `arg_descriptions` per field (the engine's documented lever for weak models,
   `_shared-types.d.ts:676-681`); engine `repair_bound: 2`; SOTA corpus measures
   the miss rate before release. Fallback lever if measured miss-rate is high:
   drop to typed-fields-only (retire the composite) — a v2 decision.
2. **Composite/field divergence** (`result_json.score ≠ result.score`).
   Nominal GKType cannot catch it. Mitigations: guidance line demanding
   agreement; handler `contract_conformant` envelope (§6.7) makes divergence
   observable in session logs and SOTA judging; downstream consumers are
   directed at the typed paths (§6.8). Accepted residual risk for v1.
3. **Enum membership is not engine-enforced** (enum → `string` TypeName).
   Mitigations: enum inlined in prompt + arg description; synthesis gate
   enforces the canned example; live UAT asserts membership on the real
   transcript. Possible future hardening: guard-aligned decision fields could
   become per-value boolean paths — rejected for v1 (explodes the arg surface).
4. **Meta-LLM JSON quality on the local Qwen substrate.** Mitigations: JSON-only
   system message, shape validation with repair context, 4 attempts, cache of
   accepted contracts, deterministic fallback with loud audit. Hard evidence
   gathered by the §10.6 drive with `REQUIRE_LLM=1`.
5. **Scripted-path GKType parity.** Observed: scripted smoke payload keys reach
   `from_arg` mutations (§6.7 evidence). Not yet observed: whether GKType gates
   the scripted-author path identically to the live path. Verification step
   (phase 2): a 20-line spike against `@simodelne/pgas-server/testing.js`
   emitting a wrong-typed scripted arg; if the harness bypasses GKType, the
   generated smoke additionally asserts typed-path values directly from the
   snapshot so conformance is still tested.
6. **Prompt injection via mandate text into the meta-prompt.** Same posture as
   body synthesis: context is labeled untrusted JSON; the contract is *data*
   validated by `assertReasoningContract` (identifier regexes, bounded sizes)
   and woven through `js-yaml` `dump` — no code is generated from it, and the
   woven spec must still pass `loadSpecWithPatterns`.
7. **Spec sha drift between `architecture_design` approval and `branch_write`.**
   The user approves a plan whose spec is later rewoven. Mitigation: audit
   carries `spec_sha256_before/after` (§9) and the REPL surfaces "reasoning
   contracts woven for stages: …" before `branch_write`. Open question for the
   owner: should `scaffold_plan` re-approval be forced when the sha changes?
   Recommended **no** (the plan approves artifact *paths and intent*, which are
   unchanged), but flagged for Codex review. **Codex confirmed** this is
   technically allowed — `branch_write` gates on the approved artifact plan +
   write authorization, not the spec hash (`gates.ts:239`) — and agrees a forced
   re-approval is unnecessary, provided the reweave is surfaced loudly (§9).
8. **Fallback-vs-hard-fail default is an OPEN OWNER DECISION (raised by Codex).**
   §5.5 as written *opts into* strictness: provider-configured-but-failed falls
   through to the deterministic fallback (with loud audit) **unless**
   `PGAS_REASONING_CONTRACT_REQUIRE_LLM=1`. Codex flags this as a genuine policy
   change from the existing body-synthesis contract, which is retry-then-**hard-fail**
   with no fallback (`domain-synthesis.ts:181,214`). Codex's preference is to
   **invert the default**: fallback only on the *no-provider* hermetic path, and
   hard-fail when a configured provider fails, gated instead by an explicit
   opt-in (`ALLOW_REASONING_FALLBACK=1`). Trade-off: the current default keeps a
   flaky local Qwen substrate from blocking every build (fallback is audited, and
   live graduation sets `REQUIRE_LLM=1` so a *graduated* program never ships a
   silent fallback); Codex's inversion is safer-by-default but makes CI/build more
   brittle to provider flakiness. **Decision required from Simone before
   implementation.** Recommendation if forced to choose now: adopt Codex's
   inversion (default hard-fail on configured-provider failure; `ALLOW_..._FALLBACK=1`
   to opt in), because it matches the established body-synthesis policy and the
   "no silent degradation" invariant, and the hermetic no-provider path is
   unaffected either way.

## 13. Implementation outline (ordered)

- **Phase 1 — contract module** (~1 day): `src/foundry-program/reasoning-contract.ts`
  (types, `assertReasoningContract`, provider generator + env knobs, cache,
  `deriveFallbackReasoningContract`) + `tests/unit/reasoning-contract.test.ts`.
  No behavior change anywhere else; `npm test` green.
- **Phase 2 — weave** (~1.5 days): `SynthesizeProgramSpecOptions.reasoningContracts`,
  `resynthesizeWithReasoningContracts`, changes in `promptForStage`,
  `guidanceFor`, `actionMapEntryFor`, schema/projection loops,
  `renderContractsSource`, `renderToolsSource`, `renderHandlersSource`,
  `renderSmokeTestSource`; delete `renderLlmReasoningStageBody`; weave unit
  tests + no-contract byte-identity test; scripted-path GKType spike (§12.5).
- **Phase 3 — domain-synthesis integration** (~1 day): contract loop + re-weave
  ordering in `synthesizeDomainLogic`, contract-record stage sources, audit
  shape, fixture seeding (§6.8), `SYNTHESIS_VERSION` v6 bump; regenerate golden
  fixtures (§10.2); update `tests/unit/domain-synthesis.test.ts` audit
  assertions.
- **Phase 4 — SOTA** (~1 day): corpus `llm_outputs` per-field args, oracle
  typed-path assertions, checked-in contract cache, `fee-calculator` body-cache
  regeneration + hermetic replay proof.
- **Phase 5 — live acceptance + release** (~0.5–1 day incl. one live-drive
  session on the lab box; needs the GPU host per fleet policy): §10.6 standalone
  graduation drive with `REQUIRE_LLM=1`, evidence capture, `MEMORY.md` +
  `docs/PGAS-NEW-ARCHITECTURE.md` note for the new audit fields, version bump
  to v3.10.0.

Total: **~5 engineer-days** plus one supervised live session.

## 14. Governance notes

- Engine boundary (CLAUDE.md): no new imports. The meta-LLM call is a plain
  OpenAI-compatible `fetch` like `createOpenAiCompatibleBodyGenerator`; the
  weave uses only spec-level features already consumed via
  `@simodelne/pgas-server/plugin.js` (`loadSpecWithPatterns`); generated runtime
  code keeps to `PGAS_SERVER_RUNTIME_IMPORTS` and generated tests to
  `testing.js`. If the §12.5 spike reveals a scripted-path GKType gap worth
  fixing engine-side, that is a curator request upstream, not a local patch.
- Foundry program nature: no CLI surface changes, no new modes, no template
  presets; the interactive interview remains the sole source of design intent.
- First-class records: the reasoning contract is persisted three ways — the
  generated stage module (§6.6), `contracts.ts`'s `stageReasoningContracts`,
  and the `domain_synthesis` audit — never only as a transient prompt.
