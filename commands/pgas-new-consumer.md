---
description: Scaffold a new pgas consumer repo with governance + FM-closing patterns built in (Mode A)
allowed-tools: Bash, Read, Write, Edit, AskUserQuestion
---

# /pgas-new-consumer — scaffold a new pgas consumer

This command scaffolds a **brand-new pgas consumer repository** ("Mode A").
Per the plugin's locked architectural decision, Mode A is "scaffold the
shell, then invoke Mode B (`/pgas-new-program`) internally for the
bootstrap program." Single source of truth for program shape lives in
`/pgas-new-program`.

The scaffold closes the five failure modes from
[pgas#253](https://github.com/simodelne/pgas/issues/253) by
construction. The freshly-created consumer ships with:

- **FM2** wiring (`createInnerContinuationReplayConsumer` +
  `createSessionLockExhaustedConsumer`) already registered in
  `server/index.ts`.
- **FM3** narrow `system_mode_entry` admission already in the bootstrap
  program's spec.
- **FM1** domain-fallback handler resolver helper in
  `programs/<bootstrap>/handlers/_resolver.ts`.
- **FM4** handler-backed raw-tool adapter override pattern documented in
  the program scaffold's README.
- **FM5** engine-owned `inputs.query_meta.*` paths spread into the
  consumer's schema (or TODO with explicit list if the engine doesn't
  yet export `engineOwnedContinuationPaths`).

## Flags

- `--with-frontend` — also scaffold a minimal vendored frontend under
  `frontend/` (default: off). When this flag is present, every step
  below additionally copies `templates/frontend/*` into
  `$TARGET/frontend/` with placeholder substitution, and the next-steps
  checklist includes the frontend dev-loop. See Brief 3 docs:
  `docs/PLUGIN-DEVELOPMENT.md → "Brief 3: Frontend"`. The snapshot date
  is recorded in `.claude-plugin/plugin.json#simoneosFrontendSnapshot`.

## Step 1 — gather inputs

Ask the user via `AskUserQuestion`:

1. **Consumer name** — kebab-case, e.g. `pgas-legal`, `pgas-research`.
   Used as the directory name AND the `name` in `package.json`. The
   GitHub repo MUST be created by the user under `simodelne/<name>`.
2. **Engine version pin** — default `^1.13.0` (the engine version whose
   surface the scaffold depends on — it ships the `@simodelne/pgas-server/api`
   barrel the scaffold imports (pgas#256) and is the current `spec.yml` shape
   the program template renders). Used as the version range for every
   `@simodelne/pgas-*` dep in the generated `package.json`.
3. **Governance-locked parameters** — y/n. If yes, the scaffold creates
   a `governance/approved_parameters.json` stub + an `EVAL_LEDGER.md`
   stub (pgas-rag-style). If no, omit those files.
4. **With frontend** — y/n (only ask if `--with-frontend` was not
   explicitly passed). If yes, also scaffold `frontend/` from
   `templates/frontend/`.

Also resolve `{{GH_OWNER}}` via `gh api user --jq .login` (typically
`simodelne`).

## Step 2 — create the target directory

```bash
TARGET="$(pwd)/${CONSUMER_NAME}"
if [[ -e "$TARGET" ]]; then
  echo "ERROR: $TARGET already exists. Aborting." >&2
  exit 1
fi
mkdir -p "$TARGET"
```

The scaffold lives **next to** the current working directory (sibling),
not inside it. Confirm the target path with the user before writing.

## Step 3 — copy the template tree

Copy every file under `${CLAUDE_PLUGIN_ROOT}/templates/new-consumer/`
to `$TARGET`, performing placeholder substitution on every `.tmpl` file:

- `{{CONSUMER_NAME}}` → the consumer name (e.g. `pgas-legal`)
- `{{ENGINE_VERSION}}` → the pgas version range (e.g. `^1.13.0`)
- `{{GH_OWNER}}` → resolved GitHub owner (e.g. `simodelne`)
- `{{GOVERNANCE_LOCKS}}` → `true` or `false` (controls optional sections)

For each `.tmpl` file, write the substituted content to the same path
**without** the `.tmpl` extension. Files without `.tmpl` copy verbatim.

`.gitkeep` files copy as empty placeholders to preserve the directory.

### Step 3a — if `--with-frontend`, copy the vendored frontend

When the flag is set, additionally:

```bash
mkdir -p "$TARGET/frontend"
cp -R "${CLAUDE_PLUGIN_ROOT}/templates/frontend/." "$TARGET/frontend/"
```

Then run the same placeholder substitution on every `.tmpl` file under
`$TARGET/frontend/` (drop the `.tmpl` suffix on rendered output). The
frontend `.gitignore`, `vite.config.ts`, `tsconfig*.json`,
`eslint.config.js`, `src/index.css`, `src/main.tsx`,
`src/vite-env.d.ts`, `src/lib/auth.ts`, `src/lib/ws.ts`,
`src/stores/auth.ts`, `src/components/Router.tsx`,
`src/pages/MagicLinkCallback.tsx` files copy verbatim (no `.tmpl`).

Append a "Frontend" section to the consumer's `README.md`:

```markdown
## Frontend

A minimal React + Vite + Tailwind UI lives in `frontend/` (vendored
from simoneos on 2026-06-01). It speaks to `server/` via REST + WS.

  cd frontend
  cp .env.example .env.local
  npm install
  npm run dev

`VITE_PGAS_AUTH_MODE` in `frontend/.env.local` MUST match
`PGAS_AUTH_MODE` in the root `.env.local`. See
`frontend/README.md` for full details.
```

## Step 4 — install dependencies

```bash
cd "$TARGET" && npm install
```

If `--with-frontend` was set, also install the frontend deps:

```bash
cd "$TARGET/frontend" && npm install
```

If `npm install` fails (commonly: GitHub Packages auth — the consumer's
`.npmrc` references `${NPM_TOKEN}`), surface the error AND tell the user
to set `NPM_TOKEN` (a fine-grained PAT with `read:packages` on
`simodelne`) before re-running. Do not try to authenticate for them.

## Step 5 — invoke /pgas-new-program internally

Run the `/pgas-new-program` command **inside the freshly-scaffolded
consumer** with program name `main` (or ask the user for a name). This
is the canonical "Mode A → Mode B" handoff per the plugin's locked
architecture decisions.

Set CWD to `$TARGET` for the internal invocation. The bootstrap program
becomes the first entry in the consumer's `programs/` directory.

## Step 6 — initial commit

Stage everything and run `git init` + initial commit:

```bash
cd "$TARGET"
git init
git add .
git commit -m "chore: bootstrap ${CONSUMER_NAME} via claude-pgas-plugin v0.1.0"
```

Do **not** auto-create the remote — the user creates
`simodelne/${CONSUMER_NAME}` themselves and pushes.

## Step 7 — print next-steps checklist

Display this checklist to the user:

```
✓ Scaffolded ${CONSUMER_NAME} at ${TARGET}
✓ Bootstrap program ${BOOTSTRAP_NAME} created
✓ Initial commit on main

Next steps:
  1. Create the remote:    gh repo create simodelne/${CONSUMER_NAME} --public
  2. Push:                  cd ${TARGET} && git remote add origin git@github.com:simodelne/${CONSUMER_NAME}.git && git push -u origin main
  3. Apply branch protection (see BRANCH-PROTECTION.md for the gh-api commands)
  4. Set 4 required env vars (see .env.example):
       NPM_TOKEN          — for npm install (GitHub Packages read:packages PAT)
       PGAS_PROVIDER      — your default LLM provider name (e.g. ollama, gemini)
       SERVER_PORT        — pgas-server listen port (default 8787)
       AUTH_DEV_TOKEN     — placeholder until Brief 2 lands the real auth stack
  5. Install local hooks:   bash scripts/install-hooks.sh
  6. Run:                   npm run dev
  7. (if --with-frontend)   cd frontend && cp .env.example .env.local && npm run dev
                             Edit VITE_PGAS_AUTH_MODE in frontend/.env.local to match
                             PGAS_AUTH_MODE in the root .env.local.
  8. Read CLAUDE.md         — it embeds the CONSUMER-COMMS-PROTOCOL Channel 1-4
                             cycle and the classifier-denial rule. Every Claude
                             session in this repo must obey both.
  9. Author your first program prompts under programs/${BOOTSTRAP_NAME}/prompts/
     and fill in handlers under programs/${BOOTSTRAP_NAME}/handlers/.
  9. When you cut your first v0.1.0, write
     audit/ARCHITECTURE-${CONSUMER_NAME}-v0.1.0.md
     using /pgas:architecture-doc skill.
```

## Notes

- **Read the Brief.** This command is part of the plugin's v0.1
  foundation (Brief 1 of 3). Brief 2 lands `server/auth/` with the
  dev-static-token + magic-link options enabled by default. Brief 3
  lands `templates/frontend/`. Until those land, `server/auth/` is a
  stub README and `templates/frontend/` is empty.
- **Classifier-denial rule (governance I-6).** If the harness denies a
  command, STOP. Surface to the user what was attempted and why.
  Do not bypass with `dangerouslyDisableSandbox: true`.
