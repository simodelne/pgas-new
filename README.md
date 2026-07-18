# pgas-new

`pgas-new` is a PGAS-specific foundry for creating TypeScript/Node PGAS programs. It is not a general coding assistant and it does not scaffold frontend, auth, database, or persistence services beyond explicit attachment points.

The generated code targets the current public `@simodelne/pgas-server` (v3.x, engine pin 3.21.0) surfaces:

- `@simodelne/pgas-server/plugin.js`
- `@simodelne/pgas-server/create-server.js`
- `@simodelne/pgas-server/client.js`
- `@simodelne/pgas-server/channels/index.js`
- `@simodelne/pgas-server/routes/index.js`
- `@simodelne/pgas-server/testing.js` in generated tests only

Existing-repo attachment requires a repo-curator manifest at `.pgas/wiring.yml`. Without that fixed-path manifest, `pgas-new` refuses writes and produces a curator request.

## Docs

- [PGAS-new architecture](./docs/PGAS-NEW-ARCHITECTURE.md)
- [Live graduation procedure](./docs/PGAS-NEW-LIVE-GRADUATION.md)

## Quickstart

### One-shot host provisioning (recommended)

```bash
bash scripts/provision.sh
```

The script handles a fresh host end-to-end: verifies Node >=20, npm, git, GitHub Packages auth, and vLLM reachability; clones (or updates) the repo at `$HOME/pgas-new`; installs npm dependencies; runs `npm test` for verification; stages auth bootstrap material with `pgas-new init`; writes env defaults to `$HOME/.config/pgas-new/env`; and installs a global shim at `$HOME/.local/bin/pgas-new`. Idempotent -- safe to re-run.

For non-interactive admin bootstrap:

```bash
bash scripts/provision.sh --admin-email you@example.com --admin-password-file /path/to/password
```

Flags: `--repo-dir DIR`, `--ref TAG`, `--base-url URL`, `--model NAME`, `--admin-email EMAIL`, `--admin-password-file PATH`, `--skip-tests`, `--skip-vllm-check`. Run `bash scripts/provision.sh --help` for details.

After provisioning succeeds, ensure `$HOME/.local/bin` is on PATH, then:

```bash
pgas-new login
pgas-new
```

### Manual run from a checkout

```bash
npm install
npm run pgas-new -- init
npm run pgas-new -- login
npm run pgas-new
```

v3 ships the foundry REPL only. Per-domain scaffolds are no longer selected
with `--template policy-drafting`, `--template web-scraper`, or
`--template social-media-agent`; generate those programs by walking the
foundry's design interview in the bare `pgas-new` REPL.

### Auth and persistence

`pgas-new init` creates `$HOME/.local/share/pgas-new/jwt.secret` and stages a single-use `$HOME/.local/share/pgas-new/initial-admin.json`. The next server startup seeds the initial admin through the engine's public `auth.initialAdmin` config and removes that staged file after successful startup.

`pgas-new login` authenticates through the engine HTTP auth route and caches the returned JWT at `$HOME/.local/share/pgas-new/token`. `pgas-new logout` deletes that token. The REPL requires a non-expired cached token and uses the engine client with bearer auth.

Sessions are DB-backed by default at `$HOME/.local/share/pgas-new/pgas-new.db`, so they survive process restarts.

The canonical v3 design is [docs/PGAS-NEW-ARCHITECTURE.md](./docs/PGAS-NEW-ARCHITECTURE.md).
The files under [docs/graduation-evidence/](./docs/graduation-evidence/) are a
read-only regression corpus and historical examples from earlier graduation
runs, not active scaffold templates.

## Governance

Architecture changes must update [docs/PGAS-NEW-ARCHITECTURE.md](./docs/PGAS-NEW-ARCHITECTURE.md) in the same PR. The architecture-diff CI gate enforces this on pull requests against `main` by requiring a `## Architectural changes` PR-body section whenever that doc differs from the latest release tag.

Re-platforming PRs should use the re-platforming pull request template and include behavior preservation evidence for each pre-platform user-facing surface. UAT prompts must start with the intent-verification block documented in [docs/UAT-PROMPT-TEMPLATE.md](./docs/UAT-PROMPT-TEMPLATE.md).

## Commands

```bash
npm run pgas-new -- version
npm run pgas-new -- init
npm run pgas-new -- login
npm run pgas-new -- logout
npm run pgas-new
npm run pgas-new -- --slug my-agent --name "My Agent" --out /tmp/my-agent
npm run pgas-new -- plan-standalone --slug pgas-new --name "PGAS New"
npm run pgas-new -- render-standalone --slug pgas-new --name "PGAS New" --out /tmp/pgas-new
npm run pgas-new -- validate-manifest --repo /path/to/repo
npm run pgas-new -- plan-attach --repo /path/to/repo --slug review --name Review
# Per-domain standalone and existing-repo scaffolds are generated in the REPL.
npm run pgas-new -- curator-request --repo /path/to/repo --slug review --name Review --github-owner simodelne --github-repo simoneos
```

`init` supports `--email <email>` / `--password-file <path>` and aliases `--admin-email <email>` / `--admin-password-file <path>` for provisioning.

## Environment

Runtime storage/auth:

- `PGAS_DB`: SQLite database path. Default: `$HOME/.local/share/pgas-new/pgas-new.db`.
- `PGAS_JWT_SECRET`: JWT signing secret. If unset, `pgas-new` reads `$HOME/.local/share/pgas-new/jwt.secret`.
- `PGAS_JWT_ISSUER`: JWT issuer. Default: `pgas-new`.
- `PGAS_JWT_EXPIRES_IN`: token lifetime passed to the engine. Default: `7d`.

Author driver selection (`src/foundry-server.ts`):

- `PGAS_AUTHOR_DRIVER=codex-cli` (or `PGAS_PROVIDER=codex-cli`): route prompts through the local `codex exec` ChatGPT-subscription CLI via the engine's `createCodexCliUnifiedComplete`. Verify with `codex login status`. The foundry sets `PGAS_ENABLE_CODEX_DRIVER=1` automatically when this selector fires.
- `PGAS_OPENAI_API_KEY`/`OPENAI_API_KEY` set (default path): OpenAI-compatible HTTP provider.
- Codex-cli wins over OpenAI when both are configured.

OpenAI-compatible provider:

- `PGAS_OPENAI_BASE_URL`: upstream OpenAI-compatible `/v1` endpoint.
- `PGAS_OPENAI_MODEL`: model name for the engine provider.
- `PGAS_OPENAI_API_KEY`: API key value for the upstream provider.
- `PGAS_OPENAI_TOOL_CHOICE`: defaults to `required` in the CLI unless already set; override if the upstream provider needs a different engine tool-choice policy.

Session lifecycle commands map to the generated PGAS `control_plane` vocabulary:

```bash
npm run pgas-new -- session new
npm run pgas-new -- session abort
npm run pgas-new -- session status
npm run pgas-new -- session history
npm run pgas-new -- session resume
npm run pgas-new -- session help
```

## Verification

```bash
npm test
```

The default test path typechecks this package, runs the unit/static suite, renders a standalone foundry scaffold, checks for banned imports, parses the generated spec, and optionally installs/tests the generated scaffold when GitHub Packages access is available.

Final graduation still requires a user-selected live test with a real provider round trip through the generated external API.
