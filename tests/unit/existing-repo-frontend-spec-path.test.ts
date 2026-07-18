import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { synthesizeProgramSpecFromDomain } from '../../src/foundry-program/synthesizer.js';
import { loadWiringManifest } from '../../src/pgas-new/wiring-manifest.js';
import { renderExistingRepoAttachment } from '../../src/pgas-new/template-renderer.js';

// Regression: a program graduated into an existing repo must set ProgramEntry.frontendSpecPath
// to its repo-relative program directory (<programs_dir>/<slug>), or consumer QC/spec-graph
// discovery cannot locate its specs.yml (simoneos qc-program-discovery: "must expose a
// specs.yml path or be explicitly exempt"). Mirrors draft-policy's registration.

const MANIFEST = `schema_version: 1
repo: { kind: existing_repo, package_manager: npm }
pgas: { server_package: "@simodelne/pgas-server", allowed_imports: ["@simodelne/pgas-server/plugin.js"] }
paths: { programs_dir: "programs", audit_dir: "audit", pgas_new_dir: ".pgas/pgas-new" }
registration: { strategy: curator_request }
verification: { commands: { install: "npm i", typecheck: "npm run build", test: "npm test" } }
curator: { github_owner: simodelne, github_repo: simoneos }
`;

function domain(): Record<string, unknown> {
  return {
    'program.slug': 'sample-attached',
    'program.name': 'Sample Attached',
    'program.target_dir': '/tmp/sample-attached',
    'intake.purpose': 'A program attached to an existing repo.',
    'intake.entry_channel': 'user_text',
    'intake.stages_json': JSON.stringify([
      { slug: 'intake', is_bootstrap: true },
      { slug: 'work' },
      { slug: 'complete', is_terminal: true },
    ]),
    'intake.transitions_json': JSON.stringify([
      { from: 'intake', to: 'work', trigger: 'started', guard_field: 'intake.started' },
      { from: 'work', to: 'complete', trigger: 'done', guard_field: 'work.ready' },
    ]),
    'intake.completion_json': JSON.stringify({ final_stage: 'complete', guard_field: 'work.ready' }),
    'intake.delegation_json': JSON.stringify({}),
  };
}

describe('existing-repo registration frontendSpecPath', () => {
  it('stamps <programs_dir>/<slug> into the generated registration', () => {
    const repo = mkdtempSync(join(tmpdir(), 'attach-fsp-'));
    mkdirSync(join(repo, '.pgas'), { recursive: true });
    writeFileSync(join(repo, '.pgas', 'wiring.yml'), MANIFEST, 'utf8');
    const loaded = loadWiringManifest(repo);
    expect(loaded.ok, loaded.errors.join('\n')).toBe(true);

    const artifact = synthesizeProgramSpecFromDomain(domain(), { targetKind: 'existing_repo' });
    renderExistingRepoAttachment({
      repoRoot: repo,
      manifest: loaded.manifest!,
      slug: 'sample-attached',
      name: 'Sample Attached',
      synthesizedSpecYaml: artifact.spec_yaml,
      synthesizedRegistrationTs: artifact.registration_ts,
      synthesizedContractsTs: artifact.contracts_ts,
      synthesizedHandlersTs: artifact.handlers_ts,
      synthesizedHandlersIndexTs: artifact.handlers_index_ts,
      synthesizedStageSources: artifact.stage_sources,
      synthesizedToolsTs: artifact.tools_ts,
      synthesizedSmokeTestTs: artifact.smoke_test_ts,
    });

    const registration = readFileSync(join(repo, 'programs', 'sample-attached', 'registration.ts'), 'utf8');
    expect(registration).toContain("frontendSpecPath: 'programs/sample-attached'");
  });
});
