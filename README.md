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

## Governance

Architecture changes must update [docs/PGAS-NEW-ARCHITECTURE.md](./docs/PGAS-NEW-ARCHITECTURE.md) in the same PR. The architecture-diff CI gate enforces this on pull requests against `main` by requiring a `## Architectural changes` PR-body section whenever that doc differs from the latest release tag.

Re-platforming PRs should use the re-platforming pull request template and include behavior preservation evidence for each pre-platform user-facing surface. UAT prompts must start with the intent-verification block documented in [docs/UAT-PROMPT-TEMPLATE.md](./docs/UAT-PROMPT-TEMPLATE.md).

## Commands

```bash
npm run pgas-new -- version
npm run pgas-new -- plan-standalone --slug pgas-new --name "PGAS New"
npm run pgas-new -- render-standalone --slug pgas-new --name "PGAS New" --out /tmp/pgas-new
npm run pgas-new -- render-standalone --slug my-agent --name "My Agent" --out /tmp/my-agent --template social-media-agent --mandate "Post scheduling agent for SimoneOS"
npm run pgas-new -- validate-manifest --repo /path/to/repo
npm run pgas-new -- plan-attach --repo /path/to/repo --slug review --name Review
npm run pgas-new -- render-attach --repo /path/to/repo --slug draft-policy --name "Draft Policy" --template policy-drafting --mandate "risk-based policy drafting ..."
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

The default test path typechecks this package, runs the unit/static suite, renders a standalone v2 scaffold, checks for banned imports, parses the generated spec, and optionally installs/tests the generated scaffold when GitHub Packages access is available.

Final graduation still requires a user-selected live test with a real provider round trip through the generated external API.
