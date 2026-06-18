import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { prepareExistingRepoAttachment } from '../../src/pgas-new/existing-repo.js';

const VALID_MANIFEST = `
schema_version: 1
repo:
  kind: existing_repo
  package_manager: npm
pgas:
  server_package: "@simodelne/pgas-server"
  allowed_imports:
    - "@simodelne/pgas-server/plugin.js"
paths:
  programs_dir: "programs"
  audit_dir: "audit"
  pgas_new_dir: ".pgas/pgas-new"
registration:
  strategy: curator_request
verification:
  commands:
    test: "npm test"
curator:
  github_owner: simodelne
  github_repo: simoneos
`;

describe('existing repo attachment preparation', () => {
  it('denies attachment without a fixed-path wiring manifest and performs no writes', () => {
    const repo = mkdtempSync(join(tmpdir(), 'pgas-new-attach-missing-'));
    try {
      const result = prepareExistingRepoAttachment(repo, { slug: 'review', name: 'Review' });

      expect(result.ok).toBe(false);
      expect(result.writes_performed).toBe(false);
      expect(result.plan).toBeUndefined();
      expect(result.curator_request).toContain('missing .pgas/wiring.yml');
      expect(result.curator_request).toContain('No local writes were performed');
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it('denies invalid manifest attachment and explains the requirement', () => {
    const repo = mkdtempSync(join(tmpdir(), 'pgas-new-attach-invalid-'));
    try {
      mkdirSync(join(repo, '.pgas'), { recursive: true });
      writeFileSync(join(repo, '.pgas/wiring.yml'), VALID_MANIFEST.replace('@simodelne/pgas-server', '@bad/server'));

      const result = prepareExistingRepoAttachment(repo, { slug: 'review', name: 'Review' });

      expect(result.ok).toBe(false);
      expect(result.writes_performed).toBe(false);
      expect(result.curator_request).toContain('pgas.server_package must be @simodelne/pgas-server');
      expect(result.curator_request).toContain('.pgas/wiring.yml');
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it('returns an artifact plan and registration request for a valid manifest', () => {
    const repo = mkdtempSync(join(tmpdir(), 'pgas-new-attach-valid-'));
    try {
      mkdirSync(join(repo, '.pgas'), { recursive: true });
      writeFileSync(join(repo, '.pgas/wiring.yml'), VALID_MANIFEST);

      const result = prepareExistingRepoAttachment(repo, { slug: 'review', name: 'Review' });

      expect(result.ok).toBe(true);
      expect(result.writes_performed).toBe(false);
      expect(result.plan?.artifacts.map((artifact) => artifact.path)).toContain('programs/review/specs.yml');
      expect(result.registration_request).toContain('Patch points requested');
      expect(result.curator_request).toBeUndefined();
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });
});
