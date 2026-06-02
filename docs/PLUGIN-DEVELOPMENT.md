# Plugin development

This doc covers how to develop on `claude-pgas-plugin` itself
(not how to consume it — see the top-level README for that).

## Directory structure

```
claude-pgas-plugin/
├── .claude-plugin/
│   └── plugin.json              ← Claude Code plugin manifest
├── commands/                    ← slash commands (auto-discovered)
│   ├── pgas-new-consumer.md
│   └── pgas-new-program.md
├── skills/                      ← skills (auto-discovered via SKILL.md)
│   ├── 5-fm-audit/
│   ├── architecture-doc/
│   ├── spec-validate/
│   └── mode-entry-lint/
├── hooks/
│   ├── hooks.json               ← hook registration
│   ├── pre-tool-use-spec-validate.sh
│   └── post-tool-use-arch-doc-nudge.sh
├── templates/
│   ├── new-consumer/            ← Mode A scaffold (consumer repo)
│   ├── new-program/             ← Mode B scaffold (program inside consumer)
│   └── frontend/                ← (placeholder; Brief 3 fills in)
├── docs/
│   ├── MARKER-PROTOCOL.md       ← how /pgas-new-program injects
│   ├── MODE-B-DETECTION.md      ← Mode-B detection algorithm
│   └── PLUGIN-DEVELOPMENT.md    ← this file
├── tests/
│   ├── plugin-manifest.test.sh  ← structural smoke test
│   └── template-render.test.sh  ← template-render smoke test
└── .github/
    ├── workflows/ci.yml         ← CI for the plugin itself
    └── PULL_REQUEST_TEMPLATE.md
```

## Local dev install

Symlink the working tree into Claude Code's plugin cache:

```bash
mkdir -p ~/.claude/plugins/cache/local/
ln -s "$(pwd)" ~/.claude/plugins/cache/local/claude-pgas-plugin/0.1.0
```

Then point your local marketplace at `local/`. Claude Code will
discover the commands, skills, and hooks on next session start.

## Verifying after changes

```bash
bash tests/plugin-manifest.test.sh   # validates plugin.json + file references
bash tests/template-render.test.sh   # validates template YAML + marker presence
```

Both must pass before committing. CI runs the same checks on every PR.

## CI secrets

### `PLUGIN_NPM_TOKEN` — makes the server-typecheck gate run in CI

`tests/server-typecheck.test.sh` scaffolds a consumer and runs
`npm install` + `npx tsc --noEmit` against the **real** published
`@simodelne/pgas-*` packages. Those packages are published by the
**sibling** repo `simodelne/pgas`, not by this repo.

GitHub Actions' default `secrets.GITHUB_TOKEN` is **repo-scoped**: it can
read packages published by *this* repo's workflows, but it gets `403
Forbidden` reading packages from a sibling repo in the same org — even
with `permissions: { packages: read }` (that opts into a scope the token
can't satisfy cross-repo). When the test sees that 403 it **SKIPs**
(exit 0 with a diagnostic) rather than failing, so CI doesn't hard-fail —
but the gate then isn't actually catching import regressions in CI, only
locally. (Observed: CI run
[26799330441](https://github.com/simodelne/claude-pgas-plugin/actions/runs/26799330441);
tracked in [#5](https://github.com/simodelne/claude-pgas-plugin/issues/5).)

**Fix — provision an org-scoped PAT as the `PLUGIN_NPM_TOKEN` repo secret:**

1. Create a GitHub token with **`read:packages`** scope on the
   `simodelne` org:
   - Classic PAT: scopes → check `read:packages`.
   - Or fine-grained PAT: owner `simodelne`, Permissions → Packages →
     Read-only.
2. Add it to this repo: **Settings → Secrets and variables → Actions →
   New repository secret**, name `PLUGIN_NPM_TOKEN`, value = the token.

The CI workflow already consumes it:

```yaml
# .github/workflows/ci.yml — server-typecheck step
env:
  NPM_TOKEN: ${{ secrets.PLUGIN_NPM_TOKEN || secrets.GITHUB_TOKEN }}
```

The `|| secrets.GITHUB_TOKEN` fallback means **no action is required for
CI to keep passing**: until `PLUGIN_NPM_TOKEN` exists, the step uses the
default token, hits the 403, and SKIPs — exactly today's behavior. Once
the PAT is provisioned, the step authenticates and the gate runs for
real, reporting `PASS: scaffolded consumer typechecks against installed
@simodelne/pgas-server` instead of `SKIP: …403…`.

> ⚠️ **Owner action.** The PAT is a credential only the repo owner
> (Simone) can mint and store — it cannot be provisioned from a PR. The
> workflow + docs are ready; the gate stays in SKIP-in-CI mode until the
> secret is added.

## Schema reference

The plugin manifest schema (`.claude-plugin/plugin.json`) is the
official Claude Code schema. As of plugin v0.1, the manifest is
minimal (name, description, version, optional author/homepage/license).
Commands are auto-discovered from `commands/*.md`. Skills are
auto-discovered from `skills/*/SKILL.md`. Hooks are configured in a
separate `hooks/hooks.json` (per the convention seen in
`superpowers` and `commit-commands`).

Reference plugin manifests we audited while building this:

- `~/.claude/plugins/cache/claude-plugins-official/superpowers/5.1.0/.claude-plugin/plugin.json`
- `~/.claude/plugins/cache/claude-plugins-official/commit-commands/unknown/.claude-plugin/plugin.json`

If the official schema diverges (new required fields, etc.), bump the
plugin's `version` field and document the schema change in the
release notes.

## Template-rendering rules

- Files with `.tmpl` extension are rendered (placeholder substitution,
  drop the extension on write).
- Files without `.tmpl` copy verbatim.
- `.gitkeep` files are copied as empty placeholders to preserve
  directory structure.

Placeholder syntax: `{{NAME}}`. Recognised placeholders:

- `{{CONSUMER_NAME}}` — kebab-case consumer name
- `{{ENGINE_VERSION}}` — pgas engine version range (e.g. `^1.9.0`)
- `{{GH_OWNER}}` — GitHub owner (typically `simodelne`)
- `{{GOVERNANCE_LOCKS}}` — boolean (`true`/`false`)
- `{{PROGRAM_NAME}}` — kebab-case program name
- `{{PROGRAM_SLUG}}` — underscore slug (e.g. `legal-rag` → `legal_rag`)
- `{{PROGRAM_NAME_PASCAL}}` — PascalCase (e.g. `legal-rag` → `LegalRag`)

Adding a new placeholder is a non-breaking change. Removing one is
breaking — bump the major version.

## Adding a new template

1. Create the file under `templates/new-consumer/` or
   `templates/new-program/` with the `.tmpl` extension (if it uses
   placeholders) or without (if it copies verbatim).
2. Add the file to the relevant command's "copy template tree" step.
   (Both commands already copy the entire template tree recursively,
   so no per-file change is usually needed.)
3. Run `bash tests/template-render.test.sh` to confirm the file's
   `{{...}}` braces are balanced.
4. If the template encodes an FM-closure pattern, document it in the
   relevant skill SKILL.md.

## Adding a new skill

1. Create `skills/<name>/SKILL.md` with YAML frontmatter (`name:`,
   `description:`) and a markdown body.
2. The skill is auto-discovered on next Claude Code session start.
3. Add structural validation (frontmatter present, name unique) to
   `tests/plugin-manifest.test.sh`.

## Adding a new command

1. Create `commands/<name>.md` with frontmatter (`description:`,
   optionally `allowed-tools:`) and a markdown body.
2. The command is auto-discovered on next Claude Code session start.
3. Add structural validation to `tests/plugin-manifest.test.sh`.

## Hooks debugging

Hooks run as shell scripts under `${CLAUDE_PLUGIN_ROOT}/hooks/`. To
debug:

```bash
# Simulate the hook input
echo '{"command":"git commit -m test"}' | bash hooks/pre-tool-use-spec-validate.sh
```

Both bundled hooks are idempotent + safe to run multiple times.

## Brief sequence

- **Brief 1 (plugin v0.1):** foundation — manifest, commands,
  skills, hooks, templates EXCEPT auth and frontend.
- **Brief 2 (this plugin):** auth — `server/auth/` middleware, JWT
  sign/verify, magic-link routes, SQLite session permanence + magic-link
  table, `.env.example` auth section, `secrets-manifest` Auth section.
- **Brief 3 (plugin v0.3):** frontend — populate `templates/frontend/`
  with a React + Vite snapshot from simoneos.

When working on Brief 2 or 3, branch from `main`, scope the PR to
just the brief's contents, and update this doc + the README.

## Brief 2: Auth

Auth ships as part of the `new-consumer` (Mode A) scaffold only.
Mode B (`new-program` inside an existing consumer) inherits the host
consumer's auth — there is no Brief-2-equivalent template in
`templates/new-program/`.

### Files rendered by `/pgas-new-consumer`

```
server/auth/
  jwt.ts             ← signJwt / verifyJwt (HS256 via `jose`)
  middleware.ts      ← Hono middleware mounted on /api/*
  routes.ts          ← POST /auth/login, GET /auth/magic/:token, POST /auth/logout
  magic-link.ts      ← issueMagicLink / redeemMagicLink (SQLite)
  config.ts          ← authConfig + onMagicLink seam
  types.ts           ← User, AuthContext, AuthMode

db/migrations/
  0001_user_sessions.sql   ← jti → (user_email, expires_at, revoked_at)
  0002_magic_links.sql     ← token → (user_email, expires_at, consumed_at)
```

The consumer's existing migration runner (or any one-shot SQLite import)
applies these before the server starts accepting auth-protected traffic.

### Env vars (all live in `.env.local` for dev; never commit)

| Var | Purpose | Required when |
|---|---|---|
| `PGAS_AUTH_MODE` | `dev-static-token` (default) or `magic-link` | always (defaults if unset) |
| `PGAS_JWT_SECRET` | HS256 signing key, 16+ chars | `magic-link` mode |
| `PGAS_DEV_STATIC_TOKEN` | Shared bearer token | `dev-static-token` mode |
| `PGAS_SESSION_TTL_SECONDS` | JWT lifetime | optional (default 30 days) |
| `PGAS_MAGIC_LINK_TTL_SECONDS` | Magic-link redeem window | optional (default 10 minutes) |

### Switching modes

Edit `.env.local`:

```ini
# dev (zero friction)
PGAS_AUTH_MODE=dev-static-token
PGAS_DEV_STATIC_TOKEN=any-random-string

# prod (single-use email tokens)
PGAS_AUTH_MODE=magic-link
PGAS_JWT_SECRET=<openssl rand -hex 32>
```

Restart the server. The middleware reads `authConfig.mode` once at
import time (from env), so a process restart is required.

### The `onMagicLink` callback seam

The default `authConfig.onMagicLink` logs the magic URL to stdout — fine
for dev, **not** for production. To plug in a real email provider,
override the callback at server bootstrap:

```ts
import { authConfig } from './server/auth/config.js';
authConfig.onMagicLink = async (email, url) => {
  await myMailer.send({ to: email, subject: 'Sign in', text: url });
};
```

This is the ONE place a consumer wires its email provider. Do it once,
before `app.route('/auth', authRoutes)` runs.

### Out of scope for v0.1

- Password login / bcrypt — `magic-link` is the only credential flow.
- OAuth/SSO/SAML — explicit non-goal.
- Refresh tokens — JWTs expire and clients re-authenticate.
- Email-sending integration — `onMagicLink` is the seam, plugin does not
  bundle a mailer.
- Rate limiting — a `TODO(rate-limiting)` lives in `server/auth/routes.ts`.
  Production deploys MUST bolt on `hono-rate-limiter` or a reverse-proxy
  rule before exposing `/auth/login`.

## Brief 3: Frontend

Frontend ships as an **opt-in** part of the `new-consumer` (Mode A)
scaffold. Triggered by the `--with-frontend` flag on
`/pgas-new-consumer`. Mode B does NOT get a frontend — the new program
inherits whatever surface the host consumer already has.

### Snapshot policy

The `templates/frontend/` directory is a **vendored** snapshot of
`~/Desktop/simoneos/frontend/src/` (the production simoneos consumer).
We snapshot rather than symlink or git-submodule because:

- Symlinks break when consumers move files around. Vendored snapshots
  travel with the scaffold.
- Git submodules add a maintenance tax (pin discipline, recursive
  clone, CI flake) that's overkill for a UI starter kit.
- Snapshot drift is acceptable — the plugin records the date the
  snapshot was taken in `.claude-plugin/plugin.json` under the
  `simoneosFrontendSnapshot` field. Consumers who want the latest
  surface can re-vendor from upstream (procedure below).

### `simoneosFrontendSnapshot` field

`.claude-plugin/plugin.json` carries a `simoneosFrontendSnapshot`
field (ISO `YYYY-MM-DD`). This is the date the current vendored
snapshot was taken from `simoneos/frontend/`. When the snapshot is
refreshed, bump this field. Don't refresh the field without also
refreshing the actual code under `templates/frontend/`.

### Refresh procedure

When simoneos drifts and the snapshot needs updating:

1. Read `~/Desktop/simoneos/frontend/src/` carefully. Pay attention to
   the **five vendored surfaces** only:
   - `App.tsx` (top-level routing + auth gate)
   - `pages/v2/LoginPageV2.tsx` (login form structure)
   - `stores/auth.ts` (localStorage shape)
   - `hooks/useWebSocket.ts` (WS connect + reconnect)
   - `api/client.ts` (REST + 401 handling)
2. Apply matching edits to `templates/frontend/`. Do NOT pull in
   simoneos-business code (contracts, legal-flows, widgets).
3. Hard discipline check: keep `templates/frontend/src/` under 30
   files. The current snapshot has 11.
4. Bump `simoneosFrontendSnapshot` in `.claude-plugin/plugin.json` to
   today's date.
5. Re-run `bash tests/template-render.test.sh`,
   `bash tests/plugin-manifest.test.sh`, and (if you have a Node
   environment) `bash tests/frontend-scaffold.test.sh`.

### Adding a new page

1. Create `templates/frontend/src/pages/NewPage.tsx.tmpl` (if it uses
   `{{CONSUMER_NAME}}` or other placeholders) or `.tsx` (verbatim).
2. Add a route in `App.tsx.tmpl`:
   ```ts
   { pattern: '/your-path', render: () => <NewPage /> },
   ```
3. Run `bash tests/template-render.test.sh` to confirm balanced
   placeholders.

### Why we vendor instead of symlink

A symlink to `~/Desktop/simoneos/frontend/` would mean every plugin
user needs the simoneos repo cloned at that path, with the same files
on the same branches. That's a non-starter — the plugin must work on
any machine. A git submodule would mean every plugin install pulls in
~100MB of simoneos history. Vendoring (with snapshot date discipline)
is the right call for v0.1.

### Out of scope for v0.1

- Playwright/Cypress browser tests — the `tsc -b && vite build` chain
  is the verification surface.
- Storybook / component gallery.
- i18n / RTL support.
- OAuth login UI — Brief 2 ships dev-static-token + magic-link only,
  and the vendored login page covers both.
- Widget framework (`src/primitives/`, `src/catalog/`, `src/runtime/`,
  `src/theme/`) — these are simoneos-internal abstractions. Consumers
  who need them must pull them in deliberately, not by default.
- Multi-session shell / tabs / notification toast / issue reporter —
  out of the v0.1 budget. Add via your own PRs once the basics work.

## v0.1.1 — Server template fixes

Plugin v0.1.0 was test-driven on 2026-06-02 and surfaced two
blockers — both fixed in this release.

### Blocker 1: scaffolded consumer can't `npm install`

`/pgas-new-consumer` rendered everything _except_ an `.npmrc`. The
`@simodelne/*` packages live behind GitHub Packages auth; without a
scope-specific registry hint, `npm install` queried the public
registry and 404'd on the first `@simodelne/pgas-server` lookup.

Fix: `templates/new-consumer/.npmrc.tmpl` ships with:

```ini
@simodelne:registry=https://npm.pkg.github.com
//npm.pkg.github.com/:_authToken=${NPM_TOKEN}
always-auth=true
```

`${NPM_TOKEN}` is npm's own env expansion (not a Claude placeholder),
so `npm install NPM_TOKEN=<…> …` Just Works. The token needs
`read:packages` on `simodelne` — in CI it's `secrets.GITHUB_TOKEN`; on
a dev machine it's `gh auth token`.

### Blocker 2: scaffolded `server/index.ts` doesn't typecheck

v0.1.0's `server/index.ts.tmpl` imported `SessionManager`,
`ProgramRegistry`, `InMemoryEventBus`, `SqliteStore`,
`createModeEntryContinuationConsumer`,
`createInnerContinuationReplayConsumer`,
`createSessionLockExhaustedConsumer` and friends from
`@simodelne/pgas-server` (the bare specifier). On a clean install,
`npx tsc --noEmit` produced 8 errors:

```
error TS2459: Module '"@simodelne/pgas-server"' declares 'SessionManager' locally, but it is not exported.
error TS2305: Module '"@simodelne/pgas-server"' has no exported member 'ProgramRegistry'.
…
```

Root cause: `@simodelne/pgas-server`'s package `exports` map routes
`"."` to `./src/index.ts`, which is a **runnable bootstrap** (top-level
`await`, `serve(...)`, no `export` statements anywhere). The main
entry isn't a library surface.

The package's `exports` map does declare subpath patterns —
`"./*.js": "./src/*.ts"`, `"./bus/*.js": "./src/bus/*.ts"`, etc. — so
each symbol IS reachable, just under a subpath specifier. The only
existing consumer with FM2 closed end-to-end (`pgas-rag`'s
`server/src/index.ts`) uses exactly this form.

Fix: `templates/new-consumer/server/index.ts.tmpl` was rewritten to
mirror pgas-rag's subpath imports. Every pgas-server symbol now comes
in via its subpath:

```ts
import { SessionManager } from '@simodelne/pgas-server/session-manager.js';
import { ProgramRegistry } from '@simodelne/pgas-server/program-registry.js';
import { SqliteStore } from '@simodelne/pgas-server/adapters/sqlite-store.js';
import { InMemoryEventBus } from '@simodelne/pgas-server/bus/event-bus.js';
import { createModeEntryContinuationConsumer } from
  '@simodelne/pgas-server/bus/consumers/mode-entry-continuation.js';
import { createInnerContinuationReplayConsumer } from
  '@simodelne/pgas-server/bus/consumers/inner-continuation-replay.js'; // FM2
import { createSessionLockExhaustedConsumer } from
  '@simodelne/pgas-server/bus/consumers/session-lock-exhausted.js';    // FM2
```

This is a **stopgap**, not a permanent shape. The upstream engine ask
is [**pgas#256 — "Public factory API for pgas-server bootstrap (FM2
by-construction)"**](https://github.com/simodelne/pgas/issues/256).
Once `@simodelne/pgas-server@1.9.0` ships either:

- a `createServer({ store, registry, bus, ... })` factory that returns
  a fully-wired `SessionManager` + bus consumers, or
- explicit re-exports from `"."` covering at least the 8 symbols
  above,

the scaffold should collapse back to a single barrel import and the
docblock at the top of `server/index.ts.tmpl` deleted. The migration
is straightforward — every subpath import becomes a member of a
single grouped import.

### New CI gate: `server-typecheck.test.sh`

To prevent this regression class from recurring, `tests/server-typecheck.test.sh`
runs the entire scaffold → install → typecheck loop end-to-end in CI:

1. Scaffold a throwaway consumer (placeholder-substitute every `.tmpl`).
2. Scaffold a bootstrap program inside it.
3. Inject lines at each of the 4 `[pgas-plugin:*-registry]` markers in
   `server/index.ts` — the same shape `/pgas-new-program` would
   produce.
4. `npm install` against GitHub Packages with `NPM_TOKEN` resolved
   from `$NPM_TOKEN` → `gh auth token` → SKIP.
5. `npx tsc --noEmit` on the scaffolded server.
6. Assert exit 0.

The CI workflow passes `secrets.GITHUB_TOKEN` as `NPM_TOKEN`. The
smoke-tests job declares `permissions: { packages: read }` so the
token can authenticate against the `@simodelne` scope. Local devs
without a token see `SKIP: NPM_TOKEN unavailable` rather than a
failure.

**Known CI token caveat.** `secrets.GITHUB_TOKEN` is scoped to the
workflow's own repository. On `simodelne/claude-pgas-plugin` it can
only read packages published BY that repo — it gets `403 Forbidden`
when reaching for `@simodelne/pgas-*` (which live in
`simodelne/pgas`). The test detects this 403 and treats it as SKIP
(not FAIL), so CI doesn't break, but the gate's full coverage only
runs locally (`gh auth token` covers all `@simodelne` packages because
the user account owns the read scope at org level). To make the gate
genuinely fail-fast in CI, an org-scoped PAT with `read:packages` must
be set as a repo secret (e.g. `secrets.PGAS_PACKAGES_READ_TOKEN`)
and substituted for `secrets.GITHUB_TOKEN` in the workflow step. That
PAT-setup is operator-side; tracked as an improvement issue but not
blocking for v0.1.1.

### Migration plan once pgas#256 ships — ✅ DONE in v0.2.0

This was executed in plugin **v0.2.0**. pgas#256 shipped as a `/api`
subpath barrel (engine option b — an additive re-export surface), not a
`"."` re-export, so the migration used `@simodelne/pgas-server/api`
rather than the bare specifier the v0.1.1 note anticipated. See the next
section for the as-built details.

## v0.2 — server template migrated to the `/api` barrel

pgas#256 shipped in engine **v1.9.0** as `@simodelne/pgas-server/api` —
a side-effect-free re-export barrel (`src/api.ts`) that surfaces every
construction primitive a consumer bootstrap needs through one stable
path. Plugin v0.2.0 retired the v0.1.1 subpath stopgap.

**What changed**

1. `templates/new-consumer/server/index.ts.tmpl` — the seven
   `@simodelne/pgas-server/...js` subpath imports collapsed into a single
   grouped import:

   ```ts
   import {
     SessionManager,
     ProgramRegistry,
     SqliteStore,
     InMemoryEventBus,
     createModeEntryContinuationConsumer,
     createInnerContinuationReplayConsumer, // FM2 — pgas#253
     createSessionLockExhaustedConsumer,    // FM2 — pgas#253
   } from '@simodelne/pgas-server/api';
   ```

   The top-of-file docblock now documents the barrel rule (use `/api`,
   never the bare `"."` specifier — `"."` is a runnable bootstrap that
   opens a port and exports nothing). The four `[pgas-plugin:*]` markers
   and the Brief 2 auth mount order (`app.route('/auth', …)` before
   `app.use('/api/*', authMiddleware)`) are unchanged.

2. Engine pin default bumped `^1.8.0` → `^1.9.0` (the version that ships
   the barrel) in `commands/pgas-new-consumer.md` and the test scaffolds.

3. `templates/new-consumer/README.md.tmpl` — the "Server bootstrap
   caveat (v0.1.1)" section was rewritten to "Server bootstrap imports"
   describing the barrel; the stopgap is recorded as a historical note.

**Why the barrel and not the bare specifier.** `@simodelne/pgas-server`'s
`exports` map still routes `"."` to `./src/index.ts`, a runnable
bootstrap (`startTelemetry()` at import, `serve(...)` at the bottom) with
zero `export` statements. The `/api` barrel (`"./api": "./src/api.ts"`)
is the additive library surface: `export { … } from './…'` lines only,
no import-time side effects, no port opened.

**Verification.** `tests/server-typecheck.test.sh` scaffolds a consumer,
renders with `^1.9.0`, `npm install`s the real engine, and runs
`npx tsc --noEmit` — green against installed `@simodelne/pgas-server@1.9.0`,
proving the barrel resolves and every imported symbol typechecks under
1.9.0 (a wrong path would fail with "cannot find module").

> CI note: the gate above only *runs* in CI once an org-scoped
> `read:packages` PAT is provisioned (otherwise it SKIPs on a 403) —
> see "Known CI token caveat" above and tracking issue
> [#5](https://github.com/simodelne/claude-pgas-plugin/issues/5).
