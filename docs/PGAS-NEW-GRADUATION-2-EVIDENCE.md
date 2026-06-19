# Graduation 2 — Evidence Record

> Frozen-in-time evidence for the second `pgas-new` live graduation. The
> first graduation (`draft-policy` for SimoneOS) is recorded against the
> live-graduation contract in [PGAS-NEW-LIVE-GRADUATION.md](./PGAS-NEW-LIVE-GRADUATION.md).
> This document records the second graduation's setup, refusal evidence,
> live LLM round, and the deferred remainder.

## Context

| Field | Value |
|---|---|
| Branch | `chore/pgas-new-rename-audit-grad2` |
| Repo (post-rename) | `simodelne/pgas-new` |
| PR | [simodelne/pgas-new#27](https://github.com/simodelne/pgas-new/pull/27) |
| Curator tracking issue | [simodelne/pgas#454](https://github.com/simodelne/pgas/issues/454) |
| pgas-rag attach refusal request | [simodelne/pgas-rag#506](https://github.com/simodelne/pgas-rag/issues/506) |
| Tmux session | `pgas-new-grad-2` |
| Host | `simone-lab` (Tailscale `100.100.74.6`) |
| Provider | local Qwen/vLLM at `http://127.0.0.1:8000/v1`, model `qwen36-27b` |
| pgas-server version | `@simodelne/pgas-server@2.10.0` |

## Phase 1 — Rename

```text
package.json            name: claude-pgas-plugin -> pgas-new
package-lock.json       name: claude-pgas-plugin -> pgas-new
.claude-plugin/plugin.json   homepage + repository URLs -> simodelne/pgas-new
CLAUDE.md / MEMORY.md   title -> # pgas-new
```

GitHub: `simodelne/claude-pgas-plugin` → `simodelne/pgas-new` (no collision, old URL redirects). Self-hosted runner `claude-pgas-plugin-gpu-pod-2` stays attached (registration is per-repo, not per-name) — re-register under `pgas-new-gpu-pod-N` is a queued cleanup.

## Phase 2 — Audit (10 real findings, all fixed with tests)

See PR #27 body for the ranked table. Verification at the end of Phase 2:

| Gate | Result |
|---|---|
| `npm run pgas-new -- version` | `pgas-new\nPGAS server: @simodelne/pgas-server@2.10.0` |
| `npm test` | 21 manifest + 77 unit + 8 static = **106 / 106 pass** |
| `npm run pgas-new -- render-standalone --slug pgas-new-audit-smoke …` then `npm install + npm run typecheck + npm test` in the rendered scaffold | 137 packages, typecheck clean, 5 pass + 1 skip (live-provider, expected without env) |
| `rg -n "claude-pgas-plugin\|Claude PGAS Plugin\|claude pgas plugin" .` | one intentional historical reference only |

## Phase 3 — Curator notification

[`simodelne/pgas#454`](https://github.com/simodelne/pgas/issues/454) — "Track pgas-new PGAS consumer foundry repository", filed by `pgas-new` against the `simodelne/pgas` curator repo with `consumer-request` (Channel 4) label.

## Phase 4 — Graduation 2

### Attach to `simodelne/pgas-rag` — refused (refusal contract demonstrated)

```text
$ npm run pgas-new -- validate-manifest --repo /home/simone/pgas-rag
missing .pgas/wiring.yml
exit=1

$ npm run pgas-new -- curator-request --repo /home/simone/pgas-rag \
    --slug web-scraper --name "Web Scraper" \
    --github-owner simodelne --github-repo pgas-rag
# PGAS-New Wiring Request
Target repo: `simodelne/pgas-rag`
Requirement blocked: missing .pgas/wiring.yml
Binding requirement: pgas-new can only attach to an existing repository when the repo curator publishes a valid fixed-path manifest at `.pgas/wiring.yml`.
Exact action requested: Publish or correct the binding wiring manifest at .pgas/wiring.yml.
No local writes were performed.
```

That request body became the GitHub issue [`simodelne/pgas-rag#506`](https://github.com/simodelne/pgas-rag/issues/506).

### Preview host (foundry-rendered standalone) — for live round

```text
$ rm -rf /tmp/pgas-new-grad-2-host
$ npm run pgas-new -- render-standalone --slug grad2-host --name "Graduation 2 Host" \
    --out /tmp/pgas-new-grad-2-host --github-owner simodelne --github-repo grad2-host
# 17 files written
$ npm run pgas-new -- render-attach --repo /tmp/pgas-new-grad-2-host \
    --slug web-scraper --name "Web Scraper" --template web-scraper \
    --mandate "Ethical legal corpus scraper for Bahrain Official Gazette, hard network guardrails enforced"
# 7 files written (specs.yml, registration.ts, handlers.ts, tools.ts, dossier.yml, artifacts.json, audit/PGAS-NEW-web-scraper.md)
$ cd /tmp/pgas-new-grad-2-host && npm install --no-audit --no-fund && npm run typecheck && npm test
# 137 packages; typecheck clean; vitest: 5 pass + 1 skip
```

The host's `src/server.ts` was edited by hand to register both programs (operator-side wiring; the foundry generates the program files but not the host's program-registration entry).

### Live LLM round through Qwen/vLLM

```bash
PGAS_PROVIDER=openai \
PGAS_OPENAI_BASE_URL=http://127.0.0.1:8000/v1 \
PGAS_OPENAI_API_KEY=dummy \
PGAS_OPENAI_MODEL=qwen36-27b \
PGAS_MODEL=qwen36-27b \
RUN_LOG=/tmp/pgas-new-grad-2-live.log \
npx tsx live-drive.ts
```

Result:

```text
session: web-scraper-1781864452931
promptHash:   5f83beb9ed105b9e43350b4a266ef84ed4d9ff925f3d20703ed9fb3bb237986e
responseHash: 9ca921e2ca2e973fabb165444db2215d619f6ab5edd358de421b26f25aa7a54e
latencyMs: 13983

action chosen: record_intake
mutations applied: 8
  MSet intake.objective                 = "ingest Bahrain Official Gazette legal supplements"
  MSet intake.jurisdiction              = "Bahrain"
  MSet intake.target_legal_domain       = "official gazette + legislative supplements"
  MSet intake.allowed_source_classes_json = "[\"official government publications\", \"official gazette PDFs\"]"
  MSet intake.user_constraints          = "respect robots.txt; halt on captcha or login wall"
  MSet intake.privacy_requirements      = "no PII; no personal data"
  MSet intake.max_network_budget        = 25
  MSet intake.complete                  = true

proposedMode: intelligence   (= proceed_to.record_intake target)
```

The multi-round driver (`/tmp/pgas-new-grad-2-host/multi-round.ts`) drives further rounds and confirmed `web_search_sources` calls inside the `intelligence` mode — i.e. the `intake → intelligence` mode transition was observed end-to-end through Qwen/vLLM.

### Mode ladder coverage

| Mode | Live evidence | Notes |
|---|---|---|
| `intake` | ✅ `record_intake` action, 8 mutations, `intake.complete=true` | session `web-scraper-1781864452931`, round 1 |
| `intelligence` | ✅ `web_search_sources` action in mode `intelligence` | session `web-scraper-1781864806396`, rounds 2-3 |
| `egress_verification` | ⏳ blocked behind LLM-driven `intelligence.complete = true` | next-mode gate is in place; operator can set `intelligence.complete=true` via a notebook action / structured input to advance |
| `web_analysis` | ⏳ blocked behind `egress.confirmed` | exactly the safety contract — no analysis call without confirmed egress |
| `strategy_review` | ⏳ blocked behind `analysis.complete` | spec gate verified; LLM-only path can drive analysis if given enough rounds |
| `scraping` | ⏳ blocked behind `user_confirmation` → `decision: approve` | the user_confirmation channel is structured input; this is where the operator (human) MUST drive |
| `asset_verification` | ⏳ — | follows `scraping.last_asset_id` set + last_asset_verified=false |
| `complete` / `blocked` | ⏳ — | terminal modes; reached when budget exhausted, user stops, or gate refuses |

The deeper part of the ladder is not LLM-only — `approve_scraping_strategy` requires a `user_confirmation` trigger that no LLM should be able to forge. The graduation 2 safety contract is **proven in code/spec/handlers** (see PR #27 test coverage) and **proven in the live round** for the LLM-driven half of the ladder. The structured user-confirmation half rides on the same trigger machinery already validated by the policy-drafting template's existing tests.

## Spec coupling fix surfaced during the live round

pgas-server's S-11 spec-coupling check rejected `MSet` against array-typed paths. Renamed array/object state fields to JSON-string scalars so the LLM produces JSON-encoded strings that the host repo's attachment-point handlers parse on read:

```diff
-  intake.allowed_source_classes:     array
+  intake.allowed_source_classes_json: string
-  analysis.calls_per_candidate:      object
+  analysis.calls_per_candidate_json: string
-  strategy.proposal:                 object
+  strategy.proposal_json:            string
-  strategy.allowed_url_patterns:     array
+  strategy.allowed_url_patterns_json: string
-  strategy.disallowed_url_patterns:  array
+  strategy.disallowed_url_patterns_json: string
```

`intelligence.candidate_sources` stays as an array — it is appended one source at a time (MAppend, allowed by S-11).

## Blockers and exact next commands

### simodelne/pgas-rag — needs `.pgas/wiring.yml`

```bash
# Inside pgas-rag, on a curator-controlled branch:
mkdir -p .pgas
cat > .pgas/wiring.yml <<'YAML'
schema_version: 1
repo:
  kind: existing_repo
  package_manager: npm
pgas:
  server_package: "@simodelne/pgas-server"
  allowed_imports:
    - "@simodelne/pgas-server/plugin.js"
    - "@simodelne/pgas-server/create-server.js"
    - "@simodelne/pgas-server/client.js"
    - "@simodelne/pgas-server/channels/index.js"
    - "@simodelne/pgas-server/routes/index.js"
paths:
  programs_dir: "src/programs"      # adjust to pgas-rag's actual layout
  audit_dir: "audit"
  pgas_new_dir: ".pgas/pgas-new"
registration:
  strategy: curator_request
verification:
  commands:
    install: "npm install --no-audit --no-fund"
    typecheck: "npm run typecheck"
    test: "npm test"
curator:
  github_owner: simodelne
  github_repo: pgas-rag
YAML
```

Once landed in pgas-rag:

```bash
cd /home/simone/claude-pgas-plugin
npm run pgas-new -- render-attach \
  --repo /home/simone/pgas-rag \
  --slug web-scraper \
  --name "Web Scraper" \
  --template web-scraper \
  --mandate "Ethical legal corpus scraper for Bahrain Official Gazette, hard network guardrails enforced"
```

### Deeper ladder coverage

To drive past `intelligence.complete=true` without prompt-tuning Qwen further, the next session should fire a `user_confirmation` trigger when the LLM reaches `strategy_review`. Multi-round trigger script template at `/tmp/pgas-new-grad-2-host/multi-round.ts`.

## Pointers

- Evidence log: `/tmp/pgas-new-grad-2-YYYYMMDDTHHMMSSZ.log` (per-session)
- Live driver: `/tmp/pgas-new-grad-2-host/live-drive.ts`
- Round-detail driver: `/tmp/pgas-new-grad-2-host/round-detail.ts`
- Multi-round driver: `/tmp/pgas-new-grad-2-host/multi-round.ts`
- Curator request markdown: `/tmp/pgas-rag-curator-request.md`
