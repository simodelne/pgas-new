import {
  assertEqual,
  assertStage,
  cloneActual,
  type SotaFunctionalActual,
  type SotaOracle,
  type SotaStageActual,
} from '../../oracle-types.js';

const TYPED_FIELDS = ['audience', 'deadline', 'constraint', 'decision'] as const;

function expected(input: Parameters<SotaOracle['expected']>[0]): SotaFunctionalActual {
  const result = JSON.parse(input.llm_outputs?.brief_summary?.result_json ?? '{}') as Record<string, unknown>;
  const items = JSON.parse(input.llm_outputs?.brief_summary?.items_json ?? '[]') as unknown[];
  return {
    final_stage: 'complete',
    // Woven reasoning contracts write one GKType-typed flat key per core field.
    domain: Object.fromEntries(TYPED_FIELDS.map((field) => [`brief_summary.result.${field}`, result[field]])),
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
  for (const field of TYPED_FIELDS) {
    assertEqual(actual.domain[`brief_summary.result.${field}`], want.domain[`brief_summary.result.${field}`], `brief_summary.result.${field}`);
  }
}

function mutations(_input: Parameters<SotaOracle['mutations']>[0], good: SotaFunctionalActual): SotaFunctionalActual[] {
  const inventedScope = cloneActual(good);
  inventedScope.stages.brief_summary.result.constraint = 'billing changes included';
  const missingDeadline = cloneActual(good);
  delete missingDeadline.stages.brief_summary.result.deadline;
  const divergedTypedField = cloneActual(good);
  divergedTypedField.domain['brief_summary.result.decision'] = 'ship billing changes now';
  return [inventedScope, missingDeadline, divergedTypedField];
}

function stage(stageName: string, result: Record<string, unknown>, items: unknown[]): SotaStageActual {
  return { stage: stageName, result, items, raw: { result_json: JSON.stringify(result), items_json: JSON.stringify(items), digest: '' } };
}

const oracle: SotaOracle = { expected, assertOutput, mutations };
export { assertOutput, expected, mutations };
export default oracle;
