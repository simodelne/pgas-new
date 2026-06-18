import { createExistingRepoArtifactPlan, type ArtifactPlan, type ProgramIdentity } from './artifact-plan.js';
import { renderMissingWiringRequest, renderRegistrationRequest } from './curator-request.js';
import { loadWiringManifest } from './wiring-manifest.js';

export type ExistingRepoAttachmentResult =
  | {
      ok: true;
      writes_performed: false;
      plan: ArtifactPlan;
      registration_request: string;
      curator_request?: undefined;
      errors: [];
    }
  | {
      ok: false;
      writes_performed: false;
      plan?: undefined;
      registration_request?: undefined;
      curator_request: string;
      errors: string[];
    };

export function prepareExistingRepoAttachment(
  repoRoot: string,
  program: ProgramIdentity,
): ExistingRepoAttachmentResult {
  const manifestResult = loadWiringManifest(repoRoot);

  if (!manifestResult.ok || !manifestResult.manifest) {
    const reason = manifestResult.errors.join('; ');
    return {
      ok: false,
      writes_performed: false,
      curator_request: renderMissingWiringRequest({
        githubOwner: 'repo-curator',
        githubRepo: 'target-repo',
        reason,
        action: 'Publish or correct the binding wiring manifest at .pgas/wiring.yml.',
      }),
      errors: manifestResult.errors,
    };
  }

  const plan = createExistingRepoArtifactPlan(program, manifestResult.manifest);
  return {
    ok: true,
    writes_performed: false,
    plan,
    registration_request: renderRegistrationRequest({ manifest: manifestResult.manifest, plan }),
    errors: [],
  };
}
