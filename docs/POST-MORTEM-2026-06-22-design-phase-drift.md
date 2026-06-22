# Post-mortem — pgas-new design-phase drift (2026-06-19 → 2026-06-22)

**Status:** owner-acknowledged, governance corrected in commit `42dc6fa`.  
**Severity:** Critical — drifted away from the program's stated nature for ~3 days, ~7 minor releases, ~6 UAT rounds.  
**Tracking issue:** #35.

## What pgas-new is supposed to be

An **interactive PGAS-program design foundry.** The CLI surface is supposed to start a streaming REPL session against the foundry's own PGAS program. An LLM agent walks the user through 10 declared modes (`intake_intelligence → architecture_design → scaffold_plan → branch_write → static_verify → live_verify → rebase_verify → pr_graduation`), synthesizes a fresh PGAS spec from the user's intake, plans artifacts, writes them, runs the verification ladder, and graduates a PR.

The full design contract has been in `docs/PGAS-NEW-ARCHITECTURE.md` since v1.0.

## What pgas-new actually became, v2.0.0 → v2.6.0

A non-conversational one-shot file emitter. `render-standalone --template <preset>` copies one of three frozen graduation programs (`policy-drafting`, `web-scraper`, `social-media-agent`) byte-for-byte. The `--mandate "..."` flag substitutes into the preamble + dossier text but cannot change the program's shape — modes, actions, and schema are baked into the chosen preset.

The CLI never enters the design modes declared in the architecture doc. The agent never asks the user any questions. The foundry's own PGAS spec sits in `templates/pgas-new/program/specs.yml.tmpl` declaring 10 modes that were never reachable through the CLI.

## Timeline

| Date | Commit | Event |
|---|---|---|
| 2026-06-06 | (pre-v1) | v1.0.0 ships as a Claude Code plugin. `/pgas-new-program` slash command includes a 6-question design interview ("Want to design the program's mode graph now or take the default 3-mode skeleton?"). Q3's stages become mode names. The interview is the design phase. |
| 2026-06-19 | `3d832b5` "feat: add pgas-new foundry" | Single commit re-platforms from Claude-Code-plugin → TypeScript/Node CLI. Deletes 12 files including `commands/pgas-new-program.md` (465 lines, the interview), `commands/pgas-new-consumer.md`, `skills/`, `templates/new-program/spec.yml.tmpl`. Adds TypeScript CLI with `render-standalone`/`render-attach`/`validate-manifest`. Commit message describes the additions; **does not mention the interactive design phase was deleted**. |
| 2026-06-19 | (same day) | First graduation program (`policy-drafting`, manually authored in `templates/pgas-new/consumer/policy/`) lands. Used to prove the render step works. |
| 2026-06-19 | PR #27 | "graduation 2" — `web-scraper` template hand-authored as a second proof program. v2.1.0 ships. Celebrated as a successful graduation. |
| 2026-06-19 | PR #28 / #29 | "graduation 3" — `social-media-agent` template hand-authored as third proof program. v2.2.0 ships. |
| 2026-06-20 | issues #30, #31 | Safety-gap audit on the social-media-agent template files (real defects in the hand-authored graduation program). These were eventually fixed in v2.5.2 (issue #30 H1–H4 + M5). The fixes were correct *for the preset*; nobody flagged that the preset itself was the architectural drift. |
| 2026-06-21 | PRs #32, #33 | v2.3.0, v2.4.0 — CLI help fixes, streaming REPL. The new REPL was built and shipped. **Nobody connected it to the foundry's own modes.** The REPL is used by *generated* programs but the foundry never uses it to drive its own design session. |
| 2026-06-21 | UAT rounds 1–5 | Six rounds of external Codex UAT. UAT verified the CLI surface matched its `--help`. **No UAT round asked "does the implementation match the architecture doc?"** Convergence to "0 issues found" at v2.5.1 / v2.5.2 was convergence on the *wrong product*. |
| 2026-06-22 | conversation | User asked Codex to "build something via CLI" for a UAT test. I described which `--template <preset>` to pick. User replied: *"What is the role of the template? pgas-new is meant to be building anything just with a standardized scaffolding."* — and the drift was caught. |
| 2026-06-22 | `42dc6fa` | Governance correction lands: `CLAUDE.md` Program Nature section, expanded required reading, `MEMORY.md` Strategic Invariants. |

## Root cause

A single re-platforming commit (`3d832b5`) silently deleted the program's nature. The commit description called out the new TypeScript CLI, the policy template, governed scaffold gates, and graduation hardening — none of those phrases tell a reviewer that the interactive design phase was deleted.

The graduation programs (PRs #27, #28, #29) then cemented the drift. Hand-authoring three production-grade preset templates and shipping them under "graduation" framing created an alternative narrative: "pgas-new ships polished templates." That narrative was easier to defend than "pgas-new drives design sessions," because the design sessions were no longer reachable through the CLI.

Six rounds of UAT against the wrong product converged to "0 issues," because nothing in the UAT prompt asked "does this implementation match the architecture doc?" Convergence on a wrong product is indistinguishable from convergence on the right product when the only test is *does the surface work as documented in `--help`?*

## What governance was supposed to catch this

Every layer that *could have* caught the drift, with what it actually did:

| Layer | What it should have done | What it did |
|---|---|---|
| `CLAUDE.md` | Mandate reading the architecture doc; carry a Program Nature statement | Required `CLAUDE.md` + `MEMORY.md` only. No Program Nature statement. Did not link to the architecture doc. |
| `MEMORY.md` | Document strategic invariants (load-bearing, do-not-drift) separately from tactical decisions | Recorded tactical decisions only. No invariants. |
| `docs/PGAS-NEW-ARCHITECTURE.md` | Be the contract; PR review should diff against it | Was treated as historical description. The 10-mode table sat there describing a flow that the CLI bypassed; nobody noticed. |
| PR review (PRs #27, #28, #29) | Ask "does this PR preserve pgas-new's nature?" | Reviewed local correctness of the hand-authored preset, tests, generated scaffold install. The framing of each PR as "graduation N" pre-decided the answer. |
| Codex UAT (rounds 1–5) | Read the architecture doc before testing the surface; flag implementation-vs-doc contradictions as Critical | Read the prompt only. The prompts asked for surface-correctness verification, not nature-correctness verification. |
| Static tests (90 currently) | Assert architectural invariants in code | Assert behavior of existing code paths. No invariants pinned (e.g., "the CLI must surface a design command", "the consumer template enum must not appear in the user-facing flag"). |
| Re-platforming commit `3d832b5` | Acknowledge "deletes the interactive design phase" in its description; trigger a design-doc update PR | Did not mention the deletion. No architecture-doc update accompanied it. |

## Five-why

1. *Why* did pgas-new ship as a preset selector? Because the CLI didn't have an interactive design phase.
2. *Why* didn't the CLI have an interactive design phase? Because commit `3d832b5` deleted the v1 slash command that ran the 6-question interview, and didn't replace it.
3. *Why* was the deletion not flagged? Because the commit's description called out additions only ("feat: add pgas-new foundry"), no PR-template question forced disclosure of removed surfaces, and the architecture-doc/`MEMORY.md` had no invariant pinning the design phase as load-bearing.
4. *Why* did UAT (6 rounds) and PR review (#27, #28, #29) not catch the drift afterwards? Because the test framing was *does the implemented surface match the documented surface?* — and the documented surface had drifted in the same commit that broke the implementation. The architecture doc still described the original design, but it was treated as historical narrative, not contract.
5. *Why* was the architecture doc treated as historical narrative? Because `CLAUDE.md` (the governance entry point) did not require reading it, did not link to it, and did not declare it the contract. So every session, every PR review, every UAT prompt operated without the contract in scope.

The deepest cause is layer 5: governance had no enforcement function pointing back at the design contract. The architecture doc existed but was inert. Inert artifacts cannot detect drift.

## Corrections — landed in commit `42dc6fa`

**A. `CLAUDE.md` opens with a four-document required reading list.** The architecture doc is now load-bearing — every session reads it before any work.

**B. `CLAUDE.md` carries a "Program Nature" section.** States what pgas-new IS, lists what it MUST NOT drift to (preset selector, one-shot emitter, general assistant), names the foundry's own PGAS spec as the design contract.

**F. `MEMORY.md` carries a "Strategic Invariants" section.** Five invariants with explicit anti-pattern clauses. Distinct from the existing tactical-decisions log.

## Corrections — filed as follow-up issues

**C. Architectural-invariant test suite.** A new `tests/architectural-invariants.test.ts` that asserts code-level invariants the design depends on (e.g., the CLI must declare a `design` command after v2.8.0, the foundry's spec must declare each of the 10 modes, the consumer-preset enum must not exist after v3.0). Run as part of `npm test`.

**D. Architecture-doc diff as a CI gate.** For each minor release, CI computes a diff vs the previous release tag's architecture doc. The release PR must include an "Architectural changes" section enumerating any deltas (or "none"). No silent re-platforming.

**E. PR template "Program Nature" checkbox.** Required Y/N: *"Does this PR change pgas-new's program nature (the interactive design phase, the foundry-as-PGAS-program loop, or the 10-mode synthesis ladder)?"* If Y, the PR must link to an updated architecture-doc commit in the same PR.

**G. UAT intent-verification pass.** Every Codex UAT prompt from now on includes:
> Before testing the surface, read `docs/PGAS-NEW-ARCHITECTURE.md` and verify the implemented CLI surface matches the documented program nature. If you find the implementation contradicts the documented design, flag it as a Critical issue regardless of whether the surface "works."

## What we learned about LLM-driven workflows under governance

1. **Inert governance is no governance.** Documents that aren't required reading don't enforce anything. Every governance artifact needs an enforcement function — a session-start hook, a test, a CI gate, a PR-template question.
2. **Convergence on a wrong product looks identical to convergence on the right product when the only test is surface-vs-help.** UAT must verify intent, not just surface.
3. **"Graduation" framing on a PR pre-decides its review.** PRs framed as celebrations are reviewed for local correctness, not architectural coherence. Future graduations need an explicit architecture-invariant check before merge.
4. **Re-platforming commits are the highest-risk drift events.** They look like "additive" work because they add a new layer, but they almost always silently remove the old layer. A re-platforming PR template should be a different template than a feature PR template, with a "what was removed" required section.
5. **The architecture doc must declare itself as the contract.** Otherwise it gets read as history.

## Status today (2026-06-22)

- Governance corrections A, B, F landed in commit `42dc6fa`.
- Phase 1 of the v3.0 plan (move graduation programs to `docs/graduation-evidence/`, deprecate `--template <consumer>` flags) landed in commits `e239888`, `0877990`. Tests green at 90 unit / 21 manifest / 8 static.
- Phase 2 of the v3.0 plan (the `pgas-new design <slug>` command + foundry `record_program_intake` action) is pending implementation.
- Phase 3 (the deterministic `synthesize_program_spec` action + regression corpus) is pending.
- Phase 4 (remove `--template <consumer>` flags entirely; cut v3.0) is pending Phase 3.

The drift has been caught and surface-corrected. The structural correction (restoring the interactive design phase) is in flight. Governance is now in place to prevent the next one.
