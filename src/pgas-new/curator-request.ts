import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ArtifactPlan } from './artifact-plan.js';
import { renderTemplate } from './template-renderer.js';
import type { WiringManifest } from './wiring-manifest.js';

const TEMPLATE_ROOT = join(dirname(fileURLToPath(import.meta.url)), '../../templates/pgas-new/curator');

export interface MissingWiringRequestOptions {
  githubOwner: string;
  githubRepo: string;
  reason: string;
  action: string;
}

export function renderMissingWiringRequest(options: MissingWiringRequestOptions): string {
  return renderTemplate(readTemplate('missing-wiring-request.md.tmpl'), {
    ACTION: options.action,
    GITHUB_OWNER: options.githubOwner,
    GITHUB_REPO: options.githubRepo,
    REASON: options.reason,
  });
}

export function renderRegistrationRequest(options: { manifest: WiringManifest; plan: ArtifactPlan }): string {
  const artifactList = options.plan.artifacts
    .map((artifact) => {
      return `- ${artifact.kind}: ${artifact.path} | owner=${artifact.owner} | mode=${artifact.mode_introduced} | purpose=${artifact.purpose} | verification=${artifact.verification.join(',')}`;
    })
    .join('\n');
  return renderTemplate(readTemplate('registration-request.md.tmpl'), {
    ARTIFACTS: artifactList,
    GITHUB_OWNER: options.manifest.curator.github_owner,
    GITHUB_REPO: options.manifest.curator.github_repo,
    REGISTRATION_STRATEGY: options.manifest.registration.strategy,
    SLUG: options.plan.program.slug,
  });
}

function readTemplate(name: string): string {
  return readFileSync(join(TEMPLATE_ROOT, name), 'utf8');
}
