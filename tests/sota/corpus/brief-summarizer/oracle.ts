import {
  assertEqual,
  assertStage,
  cloneActual,
  type SotaFunctionalActual,
  type SotaOracle,
  type SotaStageActual,
} from '../../oracle-types.js';

function expected(input: Parameters<SotaOracle['expected']>[0]): SotaFunctionalActual {
  const result = JSON.parse(input.llm_outputs?.brief_summary?.result_json ?? '{}') as Record<string, unknown>;
  const items = JSON.parse(input.llm_outputs?.brief_summary?.items_json ?? '[]') as unknown[];
  return {
    final_stage: 'complete',
    domain: {},
    stages: {
      brief_summary: stage('brief_summary', result, items),
    },
  };
}

function assertOutput(input: Parameters<SotaOracle['assertOutput']>[0], actual: SotaFunctionalActual): void {
  const want = expected(input);
  assertEqual(actual.final_stage, want.final_stage, 'final_stage');
  assertEqual(assertStage(actual, 'brief_summary').result, want.stages.brief_summary.result, 'brief_summary.result');
  assertEqual(assertStage(actual, 'brief_summary').items, want.stages.brief_summary.items, 'brief_summary.items');
}

function mutations(_input: Parameters<SotaOracle['mutations']>[0], good: SotaFunctionalActual): SotaFunctionalActual[] {
  const inventedScope = cloneActual(good);
  inventedScope.stages.brief_summary.result.constraint = 'billing changes included';
  const missingDeadline = cloneActual(good);
  delete missingDeadline.stages.brief_summary.result.deadline;
  return [inventedScope, missingDeadline];
}

function stage(stageName: string, result: Record<string, unknown>, items: unknown[]): SotaStageActual {
  return { stage: stageName, result, items, raw: { result_json: JSON.stringify(result), items_json: JSON.stringify(items), digest: '' } };
}

const oracle: SotaOracle = { expected, assertOutput, mutations };
export { assertOutput, expected, mutations };
export default oracle;
