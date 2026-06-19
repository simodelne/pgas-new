# MEMORY - pgas-new

Read after `CLAUDE.md`. This file records current branch state and durable
decisions. It is not a changelog and not a session handoff.

## Current State - 2026-06-19

- Active branch: `feat/pgas-new-standalone-template-social-media-agent`
  (graduation 3 — standalone-repo proof through a fresh custom program template).
  Prior graduation branches: `chore/pgas-new-rename-audit-grad2` (graduation 2).
- GitHub remote was renamed `simodelne/claude-pgas-plugin` ->
  `simodelne/pgas-new`; local origin updated.
- Package name renamed from `claude-pgas-plugin` to `pgas-new`. v2.0.0 stays
  as the released version; the rename is metadata-only.
- Direction unchanged: a PGAS-specific TypeScript/Node foundry for creating
  governed PGAS programs.
- Current server target: latest checked published `@simodelne/pgas-server` is
  `2.10.0`.
- Generated runtime code must use public server imports only:
  `plugin.js`, `create-server.js`, `client.js`, `channels/index.js`, and
  `routes/index.js`. `testing.js` is test-only.
- Existing-repo attachment requires fixed `.pgas/wiring.yml`. Without a valid
  manifest, `pgas-new` must not write to that repo and may create a curator
  request.
- Existing-repo rendering is explicit through `render-attach`; it writes only
  planned per-program artifacts, refuses missing/invalid manifests, and refuses
  to overwrite existing planned files.
- Static implementation and static verification are complete on this branch:
  `npm test` passed on 2026-06-18 after focused re-review. Live graduation is
  still pending and must be user-selected before PR graduation.
- Do not touch `.remember/`; it is unrelated untracked session memory in this
  checkout.

## Decisions

### 2026-06-19 - Graduation 3 in flight (standalone repo via --template social-media-agent)

`pgas-new` now generates standalone PGAS-program repositories with a non-foundry
program template chosen at CLI time. Previously `render-standalone` only emitted
the foundry's self-program; this branch adds:

- `social-media-agent` consumer template under
  `templates/pgas-new/consumer/social-media-agent/` — 10-mode declarative state
  machine (intake → mock_adapter_check → session_bootstrap → monitor_feed →
  draft_review → human_approval → post_publish → post_verification → complete |
  blocked) with hard safety gates encoded in spec preconditions, tool guardrails
  (no real-platform domains, no credential field names, exactly one draft per
  publish call), handler `assertMockAdapter`, and dossier
  `forbidden_capabilities`.
- `render-standalone --template policy-drafting|web-scraper|social-media-agent`
  routes program-shaped artifacts (spec/handler/tool/dossier) through
  `STANDALONE_PROGRAM_OVERRIDE_BY_TEMPLATE`; non-program scaffold
  (server/REPL/tests/audit/manifest) stays foundry-default.
- `RenderStandaloneOptions` accepts `template?` and `mandate?`.
- `templates/pgas-new/tests/live-provider.test.ts.tmpl` now passes an explicit
  `LIVE_PROVIDER_TIMEOUT_MS` (default 180 s, overridable via
  `PGAS_LIVE_PROVIDER_TIMEOUT_MS`). The previous 5 s default flaked every real
  round trip.

Live round through local Qwen/vLLM (`qwen36-27b @ 100.100.74.6:8000`) drove
`record_intake` successfully on a fresh standalone repo at
`/tmp/pgas-new-grad-3-sma`, session `social-media-agent-1781884509712`. All 8
intake mutations (including `safety.no_real_credentials=true`) applied and the
mode advanced `intake → mock_adapter_check` exactly as the spec declares.
Vitest `live-provider.test.ts` ran green: 2/2 pass, 6.34 s. Full evidence in
`docs/PGAS-NEW-GRADUATION-3-STANDALONE.md`. tmux session
`pgas-new-grad-3-standalone`; transcript snapshots in
`/tmp/pgas-new-grad-3-logs/`.

Open follow-up: REPL `controlCliAdapter` rejects the default `dev-token` baked
into the rendered `src/repl/index.ts.tmpl`. The HTTP API surface is unaffected
and the scaffolded `npm run dev` server runs fine. Pre-existing scaffold
limitation, not new on this branch.

### 2026-06-19 - Graduation 2 in flight on this branch (web-scraper template + live LLM round)

`pgas-new` now ships a `web-scraper` program template — a safety-critical,
network-aware PGAS consumer with 9 modes (intake → intelligence →
egress_verification → web_analysis → strategy_review → scraping →
asset_verification → complete | blocked) and hard guardrails at the
spec/gate, tool, and handler layers (no target-site call before
`egress.confirmed`, no scraping before `strategy.user_approved`, exactly
one asset per `fetch_one_asset` with `last_asset_verified` gate between
fetches, `assertSinglularPayload` rejecting URL arrays / wildcards /
`xargs` / `parallel` / shell loops, durable ledger declared as state).

Live round through local Qwen/vLLM (`qwen36-27b @ 127.0.0.1:8000`) drove
`record_intake` successfully on session `web-scraper-1781864452931` with
all 8 intake mutations applied and `proposedMode: intelligence` — proof
the foundry-generated program loads and runs end-to-end through
`@simodelne/pgas-server@2.10.0` with a real provider round trip.

Curator requests filed:
- `simodelne/pgas#454` — track `pgas-new` as a consumer foundry.
- `simodelne/pgas-rag#506` — publish `.pgas/wiring.yml` so pgas-new can
  attach the web-scraper into pgas-rag (the foundry currently refuses
  attach with `missing .pgas/wiring.yml`, which is the intended refusal
  contract working as designed).

### 2026-06-19 - Audit pass closed silent-failure modes

Foundry audit added overwrite refusal to `render-standalone` (parity with
`render-attach`), loud-failure on missing template token in the global pool,
fail-not-skip on live-provider env-present-verifier-missing, explicit stderr
marker when child stdio streams are null, and ENOENT-only catch in the
manifest-refusal test helper. Also added `curator_request -> repo_targeting`
to the gate engine (spec template already declared it). `BASE_ACTIONS_BY_MODE`
became a total `Record` so future mode additions fail to compile rather than
silently produce zero legal actions. Dossier templates now use a YAML literal
block scalar for `mandate`, and the foundry-template attach path no longer
silently drops `--mandate`. `.gitignore` now excludes stray `.js` next to
TypeScript sources (Node-ESM resolution would otherwise prefer the stale
compiled output and mask source changes).

### 2026-06-18 - v1 plugin surfaces removed from the foundry branch

The old user-facing plugin commands, skills, hooks, and consumer/frontend
templates were removed from the `pgas-new` branch. The current branch should not
advertise or test `commands/pgas-new-consumer.md`, `commands/pgas-new-program.md`,
`templates/new-consumer`, `templates/new-program`, `templates/frontend`, `skills`,
or `hooks`.

### 2026-06-18 - Session lifecycle controls are part of the control plane

The REPL/control-plane surface includes free text plus session commands:
`ask`, `new`, `abort`, `history`, `status`, `resume`, and `help`. The governed
action vocabulary includes matching session lifecycle actions, with abort gated
on an active running session.

### 2026-06-18 - Verification success must be evidence-backed

Generated specs should not let a tool call directly manufacture success by
setting `*_passed` booleans. Verification actions record status and evidence ids;
mode transitions check those state fields.

### 2026-06-18 - Spec, model, and gate contracts stay aligned

The generated PGAS spec, TypeScript model, and local gate checks now share the
same state facts for artifact approval, architecture readiness, research
authorization, and live-provider intent. Default `npm test` includes the
manifest/legacy-surface cleanup gate, and the public-import scan uses the
TypeScript AST rather than regex-only `from` import matching.

### 2026-06-18 - Notebook is durable program state

User inputs, ideas, design notes, and evidence belong in the notebook-backed
world/domain. PGAS `ActivationAction` can support advisory next-turn projection,
but it is not the primary memory mechanism for `pgas-new`.

## Pending Before Graduation

- Conduct a real-provider live test through the generated external API.
- Rebase the graduation branch on the latest target branch.
- Rerun static verification after rebase.
- Open the PR with static and live evidence.
