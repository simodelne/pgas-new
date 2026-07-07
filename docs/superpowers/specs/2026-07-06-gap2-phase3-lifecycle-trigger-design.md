# Gap 2 Phase 3 — collection_lifecycle sub-state signals: recommendation

- **Date:** 2026-07-06
- **Status:** RECOMMENDATION for review (doc-only; no code, no push, no release)
- **Author:** Claude (day supervision, 2026-07-06)
- **Repo state referenced:** `main` @ `48d44997` (post-#136)

## TL;DR — recommendation

Adopt **Option A**: extend `collection_lifecycle` synthesis with **derived
sub-state guard fields** (booleans computed from the items collection) that
generated programs can guard mode transitions on — emitted **demand-driven**
(only when a declared transition/completion references them, never
speculatively). This is the PGAS-idiomatic default and, per the engine contract,
the **only** option buildable in-repo. Option B (a reaction that emits a
transition) is **impossible without an upstream engine change** and is out of
scope for a consumer-side build.

**Residual blocker: none hard.** The A-vs-B architecture choice is *forced* by
the engine boundary, not a matter of taste — so it does **not** require Simone. A
future agent can implement the first increment directly from §4–§6 below. The
only optional owner input is prioritization (build now vs. wait for a concrete
drafting program that needs sub-state branching); the design is non-speculative
either way because gates are emitted only on demand.

## 1. State of `main` (verified, not assumed)

- `collection_lifecycle` unit tests: **10/10 green**. No RC-5, no coupling.
- Phase 2 (#135) already gives **one** reaction ownership of all lifecycle
  writes: `apply_<name>_lifecycle_event` (`AfterRound`) owns
  `[items_path, event_path, violation_path]`
  (`src/foundry-program/synthesizer.ts:588`); `compute_<name>_all_terminal` owns
  only `[aggregate.guard_field]` (`:598`). Disjoint scopes → no RC-5.
- The RC-5 `CouplingError` existed **only** in discarded Phase 3 code (a second
  "trigger-bridge" reaction that also wrote `event_path`/`violation_path`).

## 2. The binding constraint (why Option A is forced)

`@simodelne/pgas-server/dist-bundle/_shared-types.d.ts:653`:

```ts
export interface ReactionResult {
  mutations?: ReactionMutation[];
  guidance?: string[];
}
```

**A reaction can only write world paths and add guidance — it cannot emit a mode
transition or trigger delta.** Advancing the state machine is exclusively the job
of **declared mode transitions** evaluated against guard fields. So a
reaction-driven "trigger-bridge" (discarded Phase 3) cannot work in principle;
folding it into the apply reaction wouldn't grant it a power no reaction has.
This confirms the standing "reaction transition-delta (Gap2 Phase5)" note: it is
an upstream capability that does not exist today.

## 3. The actual gap Phase 2 leaves

Today the collection exposes exactly one aggregate signal: `all_terminal`
(true once every item is in `aggregate.terminal_statuses`). For the canonical
`work_units` example (`pending → in_review → accepted|removed`), a generated
program's modes can branch on "everything is done" but **cannot** branch on
"anything in review", "nothing left pending", or "which advance just happened".
That missing sub-state visibility is what any real multi-item drafting/review
program needs (the fee-proposal post-mortem's per-item review flow is the
motivating shape).

## 4. Recommended design (Option A)

### 4.1 Derived sub-state gates (owned by the aggregate compute reaction)

Extend the single `compute_<name>_*` reaction to also derive, per demand:

- **Per-status presence gates** `<name>.any_<status>` (boolean): true iff at
  least one item currently has `status_field == <status>`. Emitted only for
  statuses referenced by a declared mode-transition guard.
- **Absence gate** `<name>.none_pending` (boolean) — sugar for
  `!any_<non_terminal_status>` when a program guards "queue drained but not all
  terminal" style transitions. Emitted only if referenced.

All derived gates live in **one** reaction's `write_scope` (the compute reaction,
extended), which stays **disjoint** from the apply reaction's
`[items, event, violation]`. RC-5-safe by construction.

### 4.2 Last-applied-event signal (owned by the apply reaction)

Optionally, the apply reaction — on the round it applies a valid transition —
also sets `<name>.last_applied_to` and `<name>.last_applied_item` (strings),
letting a mode react to a *specific* advance. These paths are added to the
**existing** apply reaction's `write_scope` (still a single owner). Emit only if
a declared guard/projection references them.

### 4.3 Demand-driven emission (non-speculative by design)

The synthesizer already knows every declared transition, completion guard, and
projection path. A derived gate is emitted **iff** some declared wiring
references it — mirroring the engine's anti-dead-wiring stance
(`ActionSemantics.query_path` / pgas#449 exemption). No gate is added
"just in case", so there is no dead surface and nothing speculative to justify to
the owner.

### 4.4 Intake surface

`intake.completion_json` / the descriptor's `transitions[].guard_field` already
carry guard-field references. The one small addition: allow a mode transition (in
the collection's `stage`) to declare `guard_field: "<name>.any_<status>"` /
`"<name>.none_pending"`; the synthesizer recognizes the `<name>.` prefix +
known-status suffix and wires the derived gate. No new top-level intake concept.

## 5. RC-5 regression rule (permanent invariant)

**Each lifecycle write path has exactly one owning reaction.** Never introduce a
second reaction listing `items_path`, `event_path`, `violation_path`, or any
derived gate already owned elsewhere. New derived gates go into the **existing**
compute reaction; per-event signals go into the **existing** apply reaction. Add
a synthesizer-level assertion + unit test that no world path appears in more than
one reaction `write_scope` (a static RC-5 lock that would have caught the
discarded Phase 3).

## 6. Exact validation (tests + live proof)

**Unit (`tests/unit/synthesizer-collection-lifecycle.test.ts`):**
1. A descriptor whose `review_work` mode declares a transition guarded on
   `work_units.any_in_review` synthesizes a spec where (a) `work_units.any_in_review`
   is in `schema` as `boolean`, (b) it appears in **exactly one** reaction
   `write_scope` (the compute reaction), (c) the guarded transition references it.
2. A descriptor that references **no** derived gate emits **none** (demand-driven
   proof — no dead surface).
3. RC-5 lock: assert no world path is present in two reaction `write_scope`s.
4. `last_applied_to`/`last_applied_item` present in the apply reaction's
   `write_scope` iff referenced; handler sets them on a valid apply, not on a
   violation.

**Static:** generated scaffold passes the engine spec-load coupling gate
(`npm run test:static`) — the gate that flags RC-5.

**Live re-proof (behavior changes → required):** reuse the #136
generated-live-drive gate. Synthesize a program whose modes branch on
`any_in_review` / `none_pending`, drive it to `complete` against Qwen
(`PGAS_REASONING_CONTRACT_REQUIRE_LLM=1`), and assert the guard-driven mode
transition **actually fires from live model lifecycle intents** (not just that
the field exists). `provider_hits ≥ 1`, anti-stub clean, `mode == complete`.

## 7. Residual-decision verdict

| Question | Needs Simone? | Resolution |
|---|---|---|
| Option A vs B | **No** | Forced by engine boundary; B needs an upstream `ReactionResult` transition-delta (file curator request only if ever genuinely required). |
| Which signals | **No** | Demand-driven: only gates a declared guard references are emitted. Set defined in §4.1–4.2. |
| RC-5 safety | **No** | Single-owner invariant + static lock (§5). |
| Build now vs. later | **Optional** | Prioritization call only. A future agent can implement §4–§6 immediately; recommend pairing it with one concrete drafting program so the live proof (§6) exercises a real sub-state branch. |

**Bottom line:** this is no longer Simone-decision-gated. A future agent can
proceed from this recommendation to a scoped, RC-5-safe, live-proven increment.
The only open input is *whether to schedule it now*, which is a priority call,
not a design blocker.
