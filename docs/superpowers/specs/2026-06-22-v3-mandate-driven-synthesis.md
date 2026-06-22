# v3.0 Design — Mandate-driven program synthesis

Date: 2026-06-22  
Status: draft (for review)  
Tracks: issue #35

## Goal

Restore pgas-new to the architecture documented in `docs/PGAS-NEW-ARCHITECTURE.md`: a session-driven foundry that **synthesizes a new PGAS program from a mandate**, not a CLI preset-picker that copies graduation evidence.

After v3.0:

- The CLI does not bake any program designs.
- A user runs `pgas-new program <slug>`, has a real PGAS-mediated conversation through the foundry's own modes (`intake_intelligence → architecture_design → scaffold_plan → branch_write → static_verify`), and the foundry emits a freshly designed scaffold tailored to that mandate.
- The three graduation programs (`policy-drafting`, `web-scraper`, `social-media-agent`) move from `templates/pgas-new/consumer/` to `docs/graduation-evidence/` as historical proof artifacts, with their build instructions captured as mandate texts that v3.0's foundry can reproduce.

## What changes

### 1. CLI surface

**Remove:**
- `--template policy-drafting`
- `--template web-scraper`
- `--template social-media-agent`

**Keep:**
- `--template pgas-new-foundry` (the legitimate self-bootstrap path; used to render a working copy of the foundry itself, which is what runs every other design session)

**Add:**
- `pgas-new program <slug> --name "<Name>" --mandate "<mandate text>"` — primary entry point. Starts an embedded foundry server, opens a session, drives it through the design modes, writes artifacts when `branch_write` completes, exits.
- `pgas-new design <slug> --mandate "<mandate text>"` (alias) — same flow, different name if `program` reads as a noun-only.

**Reframe:**
- `render-standalone` becomes a low-level escape hatch that takes a fully synthesized program spec as input. The foundry uses it internally; humans usually shouldn't call it directly.
- `render-attach` follows the same pattern for existing-repo flows.

### 2. Foundry-as-PGAS-program is the actual implementation

The `templates/pgas-new/program/specs.yml.tmpl` already declares the 10 design modes. The foundry is *itself* a PGAS program — it just hasn't been wired up to run as the CLI's primary surface.

In v3.0:

```
pgas-new program legal-fee-proposals \
  --name "Legal Fee Proposals" \
  --mandate "Draft state-of-art legal fee proposals for SimoneOS, UAE/DIFC jurisdiction, fixed-fee billing for AI audits."
```

Internally:

1. CLI starts an embedded `@simodelne/pgas-server` with the foundry program loaded.
2. CLI opens a session with `domain_context = { query: mandate, slug, name }`.
3. CLI starts the streaming REPL (the one shipped in `templates/pgas-new/standalone/src/repl/`) but bound to the foundry's own program, not a generated one.
4. The LLM, running under the foundry's spec, drives `intake_intelligence` → asks clarifying questions if the mandate is underspecified → enters `architecture_design` → emits a fresh PGAS spec (modes, actions, schema) tailored to the mandate → enters `scaffold_plan` → emits an artifact plan → enters `branch_write` → writes the synthesized program to the target dir.
5. CLI exits when the foundry session reaches a terminal mode.

The user can also choose to stay interactive (review the proposed architecture, request revisions, etc.) — same modes, same control plane.

### 3. What the foundry actually emits

A v3.0-synthesized program is structurally the same kind of artifact the graduation programs are — but the **shape** (modes, actions, schema fields) comes from the LLM-driven design phase, not from a frozen template.

Concrete example. Mandate: "draft customer-support email replies for a SaaS startup."

- v2.6.0 (current): pick `--template policy-drafting`. Get a 5-mode program with `intake → outline → drafting → revision → complete` and fields like `policy_objectives`, `policy_type`, `jurisdiction`. Wrong shape.
- v3.0: the foundry's `architecture_design` mode reads the mandate, decides email replies need a 4-mode flow: `triage → drafting → review → send_or_revise`; with fields `ticket.id, ticket.category, ticket.customer_tier, draft.body, review.user_approved`. Right shape.

### 4. Where the graduation programs go

`templates/pgas-new/consumer/{policy,web-scraper,social-media-agent}/` → `docs/graduation-evidence/{policy-drafting,web-scraper,social-media-agent}/` with:

- The original spec/handler/tool/dossier files preserved verbatim (for historical reference + regression-corpus when validating v3.0 synthesis).
- A `MANDATE.md` capturing the mandate text that should produce a structurally-equivalent program when fed to v3.0's design phase.
- A `regression.test.ts` that feeds the mandate into a deterministic harness (mock LLM with canned responses) and asserts the synthesized spec matches the frozen-graduation spec within an equivalence margin.

This turns the three "templates" from product surface into the **deterministic regression corpus** that proves the synthesis engine doesn't drift.

### 5. CLI usability

To preserve the "I just want to render something quickly" path without re-introducing presets, v3.0 ships a small library of **named mandates** in `docs/example-mandates/`:

```
pgas-new program legal-fees --mandate-file docs/example-mandates/legal-fee-proposals.md
pgas-new program scraper --mandate-file docs/example-mandates/web-scraper.md
```

Plus an interactive mode:

```
pgas-new design my-program
> Describe what you want this program to do:
< [user types mandate]
> Asking 2 clarifying questions...
```

The example-mandates are *not* templates — they're text files. The foundry treats them identically to any other mandate. They're convenience starting points, nothing more.

## What stays the same

- The PGAS contract (public imports, banned imports, `system_mode_entry` channel, `control_plane` vocabulary).
- The streaming REPL (`index.ts` + `renderer.ts`) — generated programs get the same REPL; the foundry uses the same REPL to drive its own design session.
- The artifact-plan model — `planned-artifact-first` discipline is unchanged.
- The verification ladder (`static_verify`, `live_verify`, `rebase_verify`, `pr_graduation`).
- Existing-repo attach with `.pgas/wiring.yml` — same manifest, same refusal semantics.

## What breaks

This is a **v3.0 major** because:

1. `--template policy-drafting|web-scraper|social-media-agent` is removed.
2. The CLI's primary surface shifts from `render-standalone` (one-shot file emitter) to `program`/`design` (session-driven).
3. Generated scaffolds may have a slightly different `package.json` layout (peer-dep on the foundry's design library, if we factor anything out).

Migration note for anyone using v2.x:
- Rendered scaffolds from v2.x keep working (they don't depend on the foundry at runtime).
- Re-rendering with v3.x via `program`/`design` will produce a different shape; explicit opt-in.
- `pgas-new-foundry` template still works (it's the foundry's self-program; required for v3.x to bootstrap a copy of itself).

## Implementation phases

**Phase 1 — Capture graduation evidence (non-breaking, ships as v2.7.0):**
- Move spec/handler/tool/dossier files to `docs/graduation-evidence/` (copy, not delete).
- Add `MANDATE.md` per graduation program describing what the mandate would have been.
- Keep the `--template` flag working in v2.7.x for backwards compat; mark as deprecated in `--help`.

**Phase 2 — Implement the design CLI (additive, ships as v2.8.0):**
- Add `pgas-new program <slug> --mandate "..."` and `pgas-new design <slug>` commands.
- These call into the foundry's PGAS program (via embedded server, same as the streaming REPL).
- The foundry's `architecture_design` mode needs an `emit_spec` action that produces a `specs.yml` from the projected mandate state — this is the synthesis work.
- Existing `--template` flag still works; new commands run in parallel.

**Phase 3 — Regression corpus (additive, ships as v2.9.0):**
- For each graduation program, add a `regression.test.ts` that feeds the captured `MANDATE.md` into the synthesis engine (with deterministic LLM stub) and asserts the output matches the frozen graduation spec within tolerance.
- Establishes the test fence that prevents the synthesis engine from regressing.

**Phase 4 — Remove templates (breaking, ships as v3.0.0):**
- Delete `templates/pgas-new/consumer/`.
- Remove `--template policy-drafting|web-scraper|social-media-agent` from the CLI surface (return error suggesting `pgas-new program`).
- Update README, architecture doc, and all docs.
- Generated scaffolds from v3.0 do *not* carry baked program designs; only `pgas-new-foundry` remains as the bootstrap template.

## Open questions for review

1. **`emit_spec` action design.** The foundry's `architecture_design` mode needs to output a full PGAS spec from state. What's the shape? Free-form LLM JSON + Zod validation? A constrained DSL? A multi-action sequence (`declare_mode`, `declare_action`, `declare_schema_field`) accumulating into the artifact plan?
2. **LLM determinism for regression tests.** Phase 3 needs a deterministic stub LLM (canned responses keyed by prompt hash). Is that supported by `@simodelne/pgas-server/testing.js` already, or does it need a new test surface?
3. **Mandate expressiveness.** A single mandate string limits what the user can express. Should `pgas-new design` open an interactive intake conversation by default (using the foundry's `intake_intelligence` mode), and `pgas-new program` be the one-shot non-interactive variant?
4. **Existing-repo attach.** `render-attach` currently follows the same preset model. Phase 4 needs to decide whether attach is a thin wrapper around `program` (mandate → synthesize → write to attach paths) or a separate flow.

## Non-goals for v3.0

- A generic PGAS spec editor / GUI.
- Multi-language program generation (Python, Go, etc.) — TypeScript/Node only per the existing invariant.
- A package on the public npm registry — pgas-new stays on GitHub Packages.
- Removing the foundry's self-program template (`pgas-new-foundry`). That's the legitimate bootstrap path.
