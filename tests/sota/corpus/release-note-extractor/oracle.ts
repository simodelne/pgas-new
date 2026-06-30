import {
  assertEqual,
  assertStage,
  cloneActual,
  type SotaFunctionalActual,
  type SotaOracle,
  type SotaStageActual,
} from '../../oracle-types.js';

function expected(input: Parameters<SotaOracle['expected']>[0]): SotaFunctionalActual {
  const result = JSON.parse(input.llm_outputs?.release_note_summary?.result_json ?? '{}') as Record<string, unknown>;
  const items = JSON.parse(input.llm_outputs?.release_note_summary?.items_json ?? '[]') as unknown[];
  return {
    final_stage: 'complete',
    domain: {},
    stages: {
      release_note_summary: stage('release_note_summary', result, items),
    },
  };
}

function assertOutput(input: Parameters<SotaOracle['assertOutput']>[0], actual: SotaFunctionalActual): void {
  const want = expected(input);
  assertEqual(actual.final_stage, want.final_stage, 'final_stage');
  assertEqual(assertStage(actual, 'release_note_summary').result, want.stages.release_note_summary.result, 'release_note_summary.result');
  assertEqual(assertStage(actual, 'release_note_summary').items, want.stages.release_note_summary.items, 'release_note_summary.items');
}

function mutations(_input: Parameters<SotaOracle['mutations']>[0], good: SotaFunctionalActual): SotaFunctionalActual[] {
  const inflatedRisk = cloneActual(good);
  inflatedRisk.stages.release_note_summary.result.risk_level = 'critical';
  const inventedRollback = cloneActual(good);
  inventedRollback.stages.release_note_summary.result.customer_action = 'schedule rollback window';
  const missingActionItem = cloneActual(good);
  missingActionItem.stages.release_note_summary.items = ['product:Mobile Sync', 'version:4.8.1', 'risk_level:medium'];
  return [inflatedRisk, inventedRollback, missingActionItem];
}

function stage(stageName: string, result: Record<string, unknown>, items: unknown[]): SotaStageActual {
  return { stage: stageName, result, items, raw: { result_json: JSON.stringify(result), items_json: JSON.stringify(items), digest: '' } };
}

const oracle: SotaOracle = { expected, assertOutput, mutations };
export { assertOutput, expected, mutations };
export default oracle;
