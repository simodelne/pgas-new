# pgas-new

`pgas-new` is a PGAS-specific foundry for creating TypeScript/Node PGAS programs. It is not a general coding assistant and it does not scaffold frontend, auth, database, or persistence services beyond explicit attachment points.

The generated code targets the current public `@simodelne/pgas-server` v2 surfaces:

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

```bash
npm run pgas-new
```

v3.0 ships the foundry REPL only. Per-domain scaffolds are no longer selected
with `--template policy-drafting`, `--template web-scraper`, or
`--template social-media-agent`; generate those programs by walking the
foundry's design interview in the bare `pgas-new` REPL.

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
npm run pgas-new
npm run pgas-new -- --slug my-agent --name "My Agent" --out /tmp/my-agent
npm run pgas-new -- plan-standalone --slug pgas-new --name "PGAS New"
npm run pgas-new -- render-standalone --slug pgas-new --name "PGAS New" --out /tmp/pgas-new
npm run pgas-new -- validate-manifest --repo /path/to/repo
npm run pgas-new -- plan-attach --repo /path/to/repo --slug review --name Review
# Per-domain standalone and existing-repo scaffolds are generated in the REPL.
npm run pgas-new -- curator-request --repo /path/to/repo --slug review --name Review --github-owner simodelne --github-repo simoneos
```

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
