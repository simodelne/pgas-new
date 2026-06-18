import { describe, expect, it } from 'vitest';
import { createExistingRepoArtifactPlan } from '../../src/pgas-new/artifact-plan.js';
import { renderMissingWiringRequest, renderRegistrationRequest } from '../../src/pgas-new/curator-request.js';
import type { WiringManifest } from '../../src/pgas-new/wiring-manifest.js';

const MANIFEST: WiringManifest = {
  schema_version: 1,
  repo: { kind: 'existing_repo', package_manager: 'npm' },
  pgas: {
    server_package: '@simodelne/pgas-server',
    allowed_imports: ['@simodelne/pgas-server/plugin.js'],
  },
  paths: { programs_dir: 'programs', audit_dir: 'audit', pgas_new_dir: '.pgas/pgas-new' },
  registration: { strategy: 'curator_request' },
  verification: { commands: { test: 'npm test' } },
  curator: { github_owner: 'simodelne', github_repo: 'simoneos' },
};

describe('curator requests', () => {
  it('renders a missing wiring request with target repo and fixed path requirement', () => {
    const request = renderMissingWiringRequest({
      githubOwner: 'simodelne',
      githubRepo: 'simoneos',
      reason: 'missing .pgas/wiring.yml',
      action: 'Publish the binding wiring manifest at .pgas/wiring.yml.',
    });

    expect(request).toContain('simodelne/simoneos');
    expect(request).toContain('missing .pgas/wiring.yml');
    expect(request).toContain('.pgas/wiring.yml');
    expect(request).toContain('Publish the binding wiring manifest');
    expect(request).toContain('No local writes were performed');
  });

  it('renders a registration request with artifact plan and patch points', () => {
    const plan = createExistingRepoArtifactPlan({ slug: 'review', name: 'Review' }, MANIFEST);
    const request = renderRegistrationRequest({ manifest: MANIFEST, plan });

    expect(request).toContain('simodelne/simoneos');
    expect(request).toContain('programs/review/specs.yml');
    expect(request).toContain('audit/PGAS-NEW-review.md');
    expect(request).toContain('registration strategy: curator_request');
    expect(request).toContain('Patch points requested');
  });
});
