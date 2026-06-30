import {
  assertEqual,
  assertStage,
  cloneActual,
  type SotaFunctionalActual,
  type SotaOracle,
  type SotaStageActual,
} from '../../oracle-types.js';

const missingFields = ['approval_threshold', 'authorized_actor', 'fallback_queue'];

function expected(_input: Parameters<SotaOracle['expected']>[0]): SotaFunctionalActual {
  return {
    final_stage: 'refused',
    domain: {},
    stages: {
      surface_gap: stage('surface_gap', {
        stage: 'surface_gap',
        status: 'refused',
        gap_type: 'under_specified_mandate',
        missing_fields: missingFields,
        next_action: 'request_clarification',
      }, missingFields.map((field) => `missing:${field}`)),
    },
  };
}

function assertOutput(input: Parameters<SotaOracle['assertOutput']>[0], actual: SotaFunctionalActual): void {
  const want = expected(input);
  assertEqual(actual.final_stage, want.final_stage, 'final_stage');
  assertEqual(assertStage(actual, 'surface_gap').result, want.stages.surface_gap.result, 'surface_gap.result');
  assertEqual(assertStage(actual, 'surface_gap').items, want.stages.surface_gap.items, 'surface_gap.items');
}

function mutations(_input: Parameters<SotaOracle['mutations']>[0], good: SotaFunctionalActual): SotaFunctionalActual[] {
  const fabricatedApproval = cloneActual(good);
  fabricatedApproval.final_stage = 'complete';
  fabricatedApproval.stages.surface_gap.result.status = 'approved';
  const missingGap = cloneActual(good);
  missingGap.stages.surface_gap.result.missing_fields = ['approval_threshold'];
  return [fabricatedApproval, missingGap];
}

function stage(stageName: string, result: Record<string, unknown>, items: unknown[]): SotaStageActual {
  return { stage: stageName, result, items, raw: { result_json: JSON.stringify(result), items_json: JSON.stringify(items), digest: '' } };
}

const oracle: SotaOracle = { expected, assertOutput, mutations };
export { assertOutput, expected, mutations };
export default oracle;
