# PGAS-New Graduation 3 — Standalone Repo via `--template social-media-agent`

Date: 2026-06-19
Branch: `feat/pgas-new-standalone-template-social-media-agent`
Status: standalone scaffold rendered, installed, typechecked, deterministic tests passed,
and live LLM round trip through the external API passed against local Qwen/vLLM.

Graduation 2 proved attachment to an existing repo (web-scraper template against a
target with `.pgas/wiring.yml`). Graduation 3 proves the missing surface from
graduation 2: producing a **standalone repository** that contains a freshly
designed PGAS program, with `pgas-new` doing all the program-shaped work and the
generated repo standing on its own.

## What this graduation adds to pgas-new

`render-standalone` previously only emitted the foundry's self-program
(`pgas-new-foundry`). The PGAS server contract is the same for any program, but
the CLI had no way to ask for a different program template at standalone time, so
the only way to ship a new program in a standalone repo was to render the foundry
template and then hand-edit `specs.yml`/`handlers.ts`/`tools.ts`/`dossier.yml`.
That defeated the foundry's purpose.

Changes on this branch:

- New consumer template `templates/pgas-new/consumer/social-media-agent/`:
  - `specs.yml.tmpl` — 10-mode declarative state machine with hard safety gates.
  - `handlers.ts.tmpl` — handler stubs that name mock-only attachment points.
  - `tools.ts.tmpl` — tool registry with mock-only guardrails (no real-platform
    domains, no real credentials, exactly one draft per publish call).
  - `dossier.yml.tmpl` — intake dossier with `ethics`, `forbidden_capabilities`,
    and `attachment_points` declared up front.
- `src/pgas-new/template-renderer.ts`:
  - `ProgramTemplate` now includes `'social-media-agent'`.
  - `RenderStandaloneOptions` accepts `template?: ProgramTemplate` and `mandate?: string`.
  - New `STANDALONE_PROGRAM_OVERRIDE_BY_TEMPLATE` map routes program-shaped
    artifacts (`spec`/`handler`/`tool`/`dossier`) through any non-foundry template
    without touching the non-program scaffold (server/REPL/tests/audit/manifest).
  - New `templateForStandaloneArtifact(artifact, slug, template)` consults that
    override before falling back to the foundry path map.
  - `EXISTING_SOCIAL_MEDIA_AGENT_TEMPLATE_BY_KIND` mirrors the attach-time
    routing for the same template.
- `src/cli.ts`:
  - `render-standalone` honors `--template policy-drafting|web-scraper|social-media-agent`
    and `--mandate <text>` (it already pulled them via `programOptions`).
  - Help text and `templateOption` accept `social-media-agent`.
- `templates/pgas-new/tests/live-provider.test.ts.tmpl`:
  - Live test now uses an explicit `LIVE_PROVIDER_TIMEOUT_MS` (default 180 s,
    overridable via `PGAS_LIVE_PROVIDER_TIMEOUT_MS`). The previous default 5 s
    vitest timeout was guaranteed to flake on any real provider round trip.
- `tests/unit/template-renderer.test.ts`:
  - Two new tests exercise the standalone + `--template social-media-agent` path
    and the attach path for the same template.
  - The standalone-spec test now asserts the live-provider timeout token is
    rendered.

## Social-media-agent program design (web-navigation, mocked, approval-gated)

Per directive, no real credentials, no real login, no real posting; mock browser
adapter only; explicit human approval before any post or send; capability
declarations for browser navigation.

Modes (10): `intake → mock_adapter_check → session_bootstrap → monitor_feed →
draft_review → human_approval → post_publish → post_verification → complete |
blocked`.

Hard gates encoded in the spec, dossier, tools, and handlers — not in prose:

- `safety.no_real_credentials` must be `true` to leave `intake`.
- `browser.adapter_kind` must equal `mock` to bootstrap a session, browse a feed,
  or publish a draft.
- `approve_draft` requires a `user_confirmation` trigger with
  `inputs.user_decision.decision = "approve"`.
- `publish_one_draft` precondition checks `approval.user_approved=true`,
  `browser.adapter_kind=mock`, and `post.last_post_verified=true` (forces a
  verification round between publishes).
- `tools.ts` rejects real-platform domains (twitter.com / x.com / facebook.com /
  instagram.com / tiktok.com / linkedin.com / threads.net / bsky.app / reddit.com /
  youtube.com) anywhere in the payload, rejects credential field names
  (`password`, `oauth_token`, `access_token`, `session_cookie`, …), and rejects
  plural/array forms (`draft_ids`, `post_ids`, `targets`, `queue`, `batch`).
- `handlers.ts` enforces `adapter_kind === 'mock'` on `confirm_mock_adapter`.
- `dossier.yml` declares `forbidden_capabilities`:
  `navigate_real_platform`, `submit_real_credentials`, `publish_real_post`,
  `read_real_user_profile`.

## Evidence — exact commands and outputs

All commands ran in tmux session `pgas-new-grad-3-standalone` (window 1 = test
harness, window 2 = standalone server). Full pane transcripts live in
`/tmp/pgas-new-grad-3-logs/`.

Generated repo path: `/tmp/pgas-new-grad-3-sma`
tmux session: `pgas-new-grad-3-standalone`
Pane log: `/tmp/pgas-new-grad-3-logs/tmux-pane.log`
Server log: `/tmp/pgas-new-grad-3-logs/tmux-server.log`

### 1. pgas-new foundry baseline + after-change

```bash
npm test     # in /home/simone/claude-pgas-plugin
# 21 manifest + 79 unit + 8 static = ALL PASS (both before and after the change)
```

### 2. Render the standalone repo

```bash
npm run pgas-new -- render-standalone \
  --slug social-media-agent \
  --name "Social Media Agent" \
  --template social-media-agent \
  --mandate "Manage a demo social media account via mocked web navigation only. \
    No real credentials. No real account login. No real posting. \
    Every publish requires explicit human approval." \
  --out /tmp/pgas-new-grad-3-sma \
  --github-owner simodelne \
  --github-repo pgas-new-social-media-agent
# RENDER_EXIT=0
# 17 artifacts written (manifest, dossier, metadata, package.json, tsconfig,
# server.ts, repl/index.ts, programs/social-media-agent/{specs.yml, registration.ts,
# handlers.ts, tools.ts}, 5 tests, audit).
```

### 3. Install + typecheck + deterministic tests (inside the rendered repo)

```bash
cd /tmp/pgas-new-grad-3-sma
# .npmrc minted from `gh auth token` (write:packages scope already in place)
npm install --no-audit --no-fund   # added 137 packages in 3s; INSTALL_EXIT=0
npm run typecheck                  # TYPECHECK_EXIT=0
npm test                           # 5 tests passed, 1 skipped (live gate
                                   # intentionally skipped without env), TEST_EXIT=0
```

### 4. Standalone server brought up against simone-lab vLLM

```bash
# tmux window 2: server
export PGAS_PROVIDER=openai
export PGAS_OPENAI_BASE_URL=http://100.100.74.6:8000/v1
export PGAS_OPENAI_API_KEY=dummy-vllm-no-auth
export PGAS_MODEL=qwen36-27b
export PGAS_OPENAI_MODEL=qwen36-27b
export PGAS_OPENAI_DISABLE_THINKING=1
export PGAS_DEV_MODE=1
export PGAS_PORT=4502
NPM_TOKEN="$(gh auth token)" npm run dev
# server.constructed (programs=["social-media-agent"], port=4502, provider=openai,
# model=qwen36-27b)
```

### 5. Direct API round trip through the standalone server

```bash
# tmux window 1
curl -H "Authorization: Bearer dev-token" http://127.0.0.1:4502/programs
# {"programs":["social-media-agent"]}

# create session
curl -X POST -H "Authorization: Bearer dev-token" -H "Content-Type: application/json" \
  -d '{"program":"social-media-agent","domain_context":{"query":"standalone graduation 3 — live round trip via vLLM"}}' \
  http://127.0.0.1:4502/sessions
# sessionId=social-media-agent-1781884509712, mode=intake, running

# trigger user_text with the intake payload — 15s wall-clock through vLLM
curl -X POST -H "Authorization: Bearer dev-token" -H "Content-Type: application/json" \
  -d '{"channel":"user_text","payload":"intake: account_handle=demo-account-1, platform_class=mock-platform, persona=friendly-newscaster, topic_scope=mock-product-news, posting_cadence_per_day=2, no_real_credentials=true, demo_page_url=http://localhost:9000/mock-feed"}' \
  http://127.0.0.1:4502/sessions/social-media-agent-1781884509712/trigger
# {"result":{"kind":"EffectAction","name":"record_intake","channel":"widget_output",...}}

# session envelope after one round
curl -H "Authorization: Bearer dev-token" http://127.0.0.1:4502/sessions/social-media-agent-1781884509712
# mode=mock_adapter_check (transitioned from intake), currentRoundNumber=1
# All 8 intake mutations applied including safety.no_real_credentials=true,
# intake.complete=true.
```

The session log proves the LLM (qwen36-27b @ 100.100.74.6:8000 via vLLM) drove
the exact actions allowed by the social-media-agent spec:

- `record_intake` was the only action called.
- All 8 `record_intake` MSet mutations landed (account_handle, platform_class,
  persona, topic_scope, posting_cadence_per_day, safety.no_real_credentials,
  safety.demo_page_url, intake.complete).
- The mode advanced exactly as the spec defines: `intake → mock_adapter_check`,
  picked via the `proceed_to.record_intake: mock_adapter_check` declaration.
- Round latency: `latencyMs: 14895` recorded by pgas-server's replay journal.

### 6. Live-provider vitest gate

After bumping the template's `LIVE_PROVIDER_TIMEOUT_MS` from the default 5 s
vitest cap to 180 s and patching the rendered test:

```bash
cd /tmp/pgas-new-grad-3-sma
export PGAS_LIVE_PROVIDER=openai-vllm-qwen36-27b
export PGAS_API_BASE=http://127.0.0.1:4502
export PGAS_API_TOKEN=dev-token
NPM_TOKEN="$(gh auth token)" npx vitest run tests/live-provider.test.ts
# Test Files  1 passed (1)
# Tests       2 passed (2)
# Duration    6.34s (test: 6.12s)
# RERUN_EXIT=0
```

### 7. REPL lifecycle (initial — broken)

```bash
echo "" | timeout 8 npm run repl
# server.constructed printed, then controlCliAdapter token verification failed.
```

Root cause: `controlCliAdapter` calls `ctx.verify(token)` → `auth.verifyToken(token)`.
The HTTP dev-mode middleware bypasses `verifyToken` entirely (any bearer is
accepted), but the CLI channel has no parallel bypass — the default
`JwtAuthProvider` rejects the literal string `dev-token` because it is not a
signed JWT.

### 7b. REPL lifecycle (after the fix)

The fix injects a tiny dev-only `AuthProvider` into the REPL bootstrap
(`src/repl/index.ts`) that accepts any non-empty token and resolves to the
same `dev-user-00000000` principal the HTTP dev middleware uses. The
production `npm run dev` path (`src/server.ts`) is untouched. In non-dev mode
(`PGAS_DEV_MODE=0`) the REPL refuses to start without an explicit
`PGAS_CLI_TOKEN`.

```bash
echo "" | timeout 8 npm run repl
# server.constructed → server.starting → readline attaches → EOF → clean shutdown.
# REPL_RC=0

printf "/help\n" | timeout 8 npm run repl
# server.constructed → server.starting → /help dispatched:
#   /ask — Ask
#   /abort — Abort run
#   /new — New session
#   /history — Recent sessions
#   /status — Status
#   /resume — Resume
#   /help — Help
# REPL_RC=0
```

Verified against a freshly rendered scaffold at
`/tmp/pgas-new-grad-3-sma-repl-fix` on 2026-06-19. HTTP API surface unaffected
(verified by `GET /programs` and `POST /sessions` on the same rendered
`npm run dev` server, both returning expected JSON).

## Known follow-up

None on the standalone graduation contract. The REPL token-verification
follow-up identified in the initial graduation has been closed by the
dev-mode `AuthProvider` shim in `templates/pgas-new/standalone/src/repl/index.ts.tmpl`
and asserted by a new unit test in `tests/unit/template-renderer.test.ts`
("renders REPL with a dev-mode AuthProvider that lets controlCliAdapter accept
the default CLI token").

## What this proves

- `pgas-new` can generate a fresh standalone PGAS-program repository (not an
  attachment to an existing repo) that installs, typechecks, runs deterministic
  tests, and accepts real LLM round trips through its external API, end-to-end,
  using a custom program template chosen by the user at CLI time.
- The chosen program — a social-media account manager driven through a mocked
  browser adapter — is generated with hard safety gates declared in the spec,
  spec preconditions, tool guardrails, and dossier capability declarations, not
  in prose. The LLM cannot bypass these gates by tool-call composition.
- The live LLM (Qwen3.6-27B via local vLLM) correctly emitted `record_intake`
  with `safety.no_real_credentials=true`, drove the mode transition `intake →
  mock_adapter_check`, and stopped at the next safety gate.

This closes the graduation-3 contract: standalone repo from `pgas-new`, with a
fresh custom program, with a real provider round trip.
