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
- `{{ENGINE_VERSION}}` — pgas engine version range (e.g. `^1.8.0`)
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
