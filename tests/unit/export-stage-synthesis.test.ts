import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { load } from 'js-yaml';
import { describe, expect, it } from 'vitest';

import { synthesizeDomainLogic } from '../../src/foundry-program/domain-synthesis.js';
import { synthesizeProgramSpecFromDomain } from '../../src/foundry-program/synthesizer.js';
import { createStandaloneArtifactPlan } from '../../src/pgas-new/artifact-plan.js';

describe('PR-E2 export stage synthesis', () => {
  it('emits deterministic DOCX export stages, result_path wiring, artifact policy, and standalone export artifacts', async () => {
    const artifact = synthesizeProgramSpecFromDomain(exportDomain());
    const spec = load(artifact.spec_yaml) as { action_map: Record<string, Record<string, unknown>> };
    const exportStage = artifact.stage_classification.find((stage) =>
      typeof stage === 'object' && stage && (stage as { slug?: unknown }).slug === 'export_document') as Record<string, unknown> | undefined;

    expect(exportStage).toMatchObject({
      slug: 'export_document',
      archetype: 'pure-compute',
      export_kind: 'export_docx',
    });
    expect(spec.action_map.complete_export_document?.result_path).toBe('export_document.output');
    expect(spec.action_map.complete_export_document?.channel).toBe('stage_output');

    expect(artifact.registration_ts).toContain('artifactPolicy');
    expect(artifact.registration_ts).toContain("artifactType: 'docx_export'");
    expect(artifact.registration_ts).toContain("payloadRef: 'export_document.output'");
    expect(artifact.registration_ts).toContain("whenAllPaths: ['export_document.output.result_json']");

    const plan = createStandaloneArtifactPlan(
      { slug: 'export-demo', name: 'Export Demo' },
      { stageSlugs: artifact.body_stage_slugs, exportSurfaces: artifact.export_surfaces },
    );
    expect(plan.artifacts.map((entry) => entry.path)).toContain('src/programs/export-demo/export/docx.ts');

    const generatorCalls: string[] = [];
    const cacheDir = mkdtempSync(join(tmpdir(), 'pgas-export-stage-synthesis-'));
    try {
      const withBodies = await synthesizeDomainLogic({
        ...artifact,
        created_at: '2026-07-17T00:00:00.000Z',
      }, {
        cacheDir,
        generator: async (request) => {
          generatorCalls.push(request.stage);
          return nonExportStageBody();
        },
      });
      const body = withBodies.stage_sources?.export_document ?? '';
      expect(generatorCalls).not.toContain('export_document');
      expect(body).toContain("from '../export/docx.js'");
      expect(body).toContain('renderStructuredDocxDocument');
      expect(body).toContain('Buffer.from(bytes).toString');
      expect(body).toContain('sha256Hex(bytes)');
    } finally {
      rmSync(cacheDir, { force: true, recursive: true });
    }
  });

  it('keeps standalone export artifacts and artifactPolicy default-off without export demand', () => {
    const artifact = synthesizeProgramSpecFromDomain(noExportDomain());
    const plan = createStandaloneArtifactPlan(
      { slug: 'plain-demo', name: 'Plain Demo' },
      { stageSlugs: artifact.body_stage_slugs, exportSurfaces: artifact.export_surfaces },
    );
    const paths = plan.artifacts.map((entry) => entry.path);

    expect(paths.filter((path) => path.includes('/export/'))).toEqual([]);
    expect(artifact.export_surfaces).toBeUndefined();
    expect(artifact.registration_ts).toBeUndefined();
  });
});

function exportDomain(): Record<string, unknown> {
  return {
    'program.slug': 'export-demo',
    'program.name': 'Export Demo',
    'program.target_dir': '/tmp/export-demo',
    'intake.purpose': 'Compose a short memo and produce a DOCX export.',
    'intake.entry_channel': 'user_text',
    'intake.stages_json': JSON.stringify([
      { slug: 'intake', is_bootstrap: true },
      { slug: 'compose_memo' },
      {
        slug: 'export_document',
        kind: 'export_docx',
        domain_spec: {
          reads: ['compose_memo.output.result_json'],
          produces: {
            result_json: {
              stage: 'string',
              docx_base64: 'string',
              docx_bytes: 'number',
              sha256: 'string',
              section_count: 'number',
            },
            items_json: ['docx_export:<sha256>'],
          },
          rules: ['Render accumulated stage state into a deterministic DOCX export.'],
          invariants: ['Do not call an LLM or provider while rendering export bytes.'],
        },
      },
      { slug: 'complete', is_terminal: true },
    ]),
    'intake.transitions_json': JSON.stringify([
      { from: 'intake', to: 'compose_memo', trigger: 'started', guard_field: 'intake.started' },
      { from: 'compose_memo', to: 'export_document', trigger: 'composed', guard_field: 'compose_memo.ready' },
      { from: 'export_document', to: 'complete', trigger: 'exported', guard_field: 'export_document.ready' },
    ]),
    'intake.delegation_json': JSON.stringify({}),
    'intake.completion_json': JSON.stringify({ final_stage: 'complete', guard_field: 'export_document.ready' }),
  };
}

function noExportDomain(): Record<string, unknown> {
  return {
    'program.slug': 'plain-demo',
    'program.name': 'Plain Demo',
    'program.target_dir': '/tmp/plain-demo',
    'intake.purpose': 'Compose a short memo and finish.',
    'intake.entry_channel': 'user_text',
    'intake.stages_json': JSON.stringify([
      { slug: 'intake', is_bootstrap: true },
      { slug: 'compose_memo' },
      { slug: 'complete', is_terminal: true },
    ]),
    'intake.transitions_json': JSON.stringify([
      { from: 'intake', to: 'compose_memo', trigger: 'started', guard_field: 'intake.started' },
      { from: 'compose_memo', to: 'complete', trigger: 'composed', guard_field: 'compose_memo.ready' },
    ]),
    'intake.delegation_json': JSON.stringify({}),
    'intake.completion_json': JSON.stringify({ final_stage: 'complete', guard_field: 'compose_memo.ready' }),
  };
}

function nonExportStageBody(): string {
  return `import type { StageInput, StageOutput, StageRuntime } from '../contracts.js';

export async function runStage(input: StageInput, runtime: StageRuntime): Promise<StageOutput> {
  void runtime;
  return {
    result_json: JSON.stringify({ stage: input.stage, ready: true, summary: input.stage + ' ready' }),
    items_json: JSON.stringify([input.stage + ':ready']),
    digest: '',
  };
}
`;
}
