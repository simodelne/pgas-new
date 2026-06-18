import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadWiringManifest, parseWiringManifest, WIRING_MANIFEST_PATH } from '../../src/pgas-new/wiring-manifest.js';

const VALID_MANIFEST = `
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
    - "@simodelne/pgas-server/client/http.js"
    - "@simodelne/pgas-server/channels/index.js"
    - "@simodelne/pgas-server/routes/index.js"
    - "@simodelne/pgas-server/testing.js"
paths:
  programs_dir: "programs"
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
  github_repo: simoneos
`;

describe('wiring manifest parser', () => {
  it('parses a valid fixed-path manifest', () => {
    const result = parseWiringManifest(VALID_MANIFEST);

    expect(result.ok).toBe(true);
    expect(result.errors).toEqual([]);
    expect(result.manifest?.pgas.server_package).toBe('@simodelne/pgas-server');
    expect(result.manifest?.paths.pgas_new_dir).toBe('.pgas/pgas-new');
  });

  it('loads only .pgas/wiring.yml from a repo root', () => {
    const repo = mkdtempSync(join(tmpdir(), 'pgas-new-manifest-'));
    try {
      mkdirSync(join(repo, '.pgas'), { recursive: true });
      writeFileSync(join(repo, WIRING_MANIFEST_PATH), VALID_MANIFEST);

      const result = loadWiringManifest(repo);
      expect(result.ok).toBe(true);
      expect(result.manifest?.curator.github_repo).toBe('simoneos');
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it('reports a missing fixed-path manifest without throwing', () => {
    const repo = mkdtempSync(join(tmpdir(), 'pgas-new-missing-'));
    try {
      expect(loadWiringManifest(repo)).toEqual({
        ok: false,
        errors: ['missing .pgas/wiring.yml'],
      });
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it('rejects a manifest for the wrong server package', () => {
    const result = parseWiringManifest(VALID_MANIFEST.replace('@simodelne/pgas-server', '@example/pgas-server'));

    expect(result.ok).toBe(false);
    expect(result.errors).toContain('pgas.server_package must be @simodelne/pgas-server');
  });

  it('rejects private or non-approved pgas imports', () => {
    const result = parseWiringManifest(
      VALID_MANIFEST.replace(
        '"@simodelne/pgas-server/testing.js"',
        '"@simodelne/pgas-server/src/testing.js"',
      ),
    );

    expect(result.ok).toBe(false);
    expect(result.errors).toContain('pgas.allowed_imports contains banned import: @simodelne/pgas-server/src/testing.js');
  });

  it('ships a valid manifest template', () => {
    const template = readFileSync('templates/pgas-new/repo/.pgas/wiring.yml.tmpl', 'utf8');
    const rendered = template
      .replaceAll('{{GITHUB_OWNER}}', 'simodelne')
      .replaceAll('{{GITHUB_REPO}}', 'simoneos');

    expect(parseWiringManifest(rendered)).toMatchObject({ ok: true, errors: [] });
  });
});
