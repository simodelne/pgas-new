import {
  assertEqual,
  assertStage,
  cloneActual,
  type SotaFunctionalActual,
  type SotaOracle,
  type SotaStageActual,
} from '../../oracle-types.js';

const TYPED_FIELDS = ['approved', 'basis', 'discounted_total_usd', 'budget_usd'] as const;

function expected(input: Parameters<SotaOracle['expected']>[0]): SotaFunctionalActual {
  const subtotal = Number(input.domain.base_hours) * Number(input.domain.hourly_rate_usd);
  const discounted = Math.round(subtotal * (1 - Number(input.domain.discount_pct) / 100));
  const budget = Number(input.domain.budget_usd);
  const summary = JSON.parse(input.llm_outputs?.approval_summary?.result_json ?? '{}') as Record<string, unknown>;
  const summaryItems = JSON.parse(input.llm_outputs?.approval_summary?.items_json ?? '[]') as unknown[];
  return {
    final_stage: 'complete',
    // Woven reasoning contracts write one GKType-typed flat key per core field.
    domain: Object.fromEntries(TYPED_FIELDS.map((field) => [`approval_summary.result.${field}`, summary[field]])),
    stages: {
      estimate_fee: stage('estimate_fee', {
        stage: 'estimate_fee',
        base_hours: input.domain.base_hours,
        hourly_rate_usd: input.domain.hourly_rate_usd,
        subtotal_usd: subtotal,
      }, [`subtotal_usd:${subtotal}`]),
      apply_discount: stage('apply_discount', {
        stage: 'apply_discount',
        previous_total_usd: subtotal,
        discount_pct: input.domain.discount_pct,
        discounted_total_usd: discounted,
      }, [`previous_total_usd:${subtotal}`, `discounted_total_usd:${discounted}`]),
      approval_summary: stage('approval_summary', summary, summaryItems),
    },
  };
}

function assertOutput(input: Parameters<SotaOracle['assertOutput']>[0], actual: SotaFunctionalActual): void {
  const want = expected(input);
  assertEqual(actual.final_stage, want.final_stage, 'final_stage');
  for (const stageName of ['estimate_fee', 'apply_discount', 'approval_summary']) {
    assertEqual(assertStage(actual, stageName).result, want.stages[stageName].result, `${stageName}.result`);
    assertEqual(assertStage(actual, stageName).items, want.stages[stageName].items, `${stageName}.items`);
  }
  assertEqual(
    assertStage(actual, 'apply_discount').result.previous_total_usd,
    assertStage(actual, 'estimate_fee').result.subtotal_usd,
    'cross-stage previous_total_usd',
  );
  for (const field of TYPED_FIELDS) {
    assertEqual(actual.domain[`approval_summary.result.${field}`], want.domain[`approval_summary.result.${field}`], `approval_summary.result.${field}`);
  }
}

function mutations(_input: Parameters<SotaOracle['mutations']>[0], good: SotaFunctionalActual): SotaFunctionalActual[] {
  const brokenDependency = cloneActual(good);
  brokenDependency.stages.apply_discount.result.previous_total_usd = 999;
  const wrongApproval = cloneActual(good);
  wrongApproval.stages.approval_summary.result.approved = false;
  const divergedTypedField = cloneActual(good);
  divergedTypedField.domain['approval_summary.result.approved'] = false;
  return [brokenDependency, wrongApproval, divergedTypedField];
}

function stage(stageName: string, result: Record<string, unknown>, items: unknown[]): SotaStageActual {
  return { stage: stageName, result, items, raw: { result_json: JSON.stringify(result), items_json: JSON.stringify(items), digest: '' } };
}

const oracle: SotaOracle = { expected, assertOutput, mutations };
export { assertOutput, expected, mutations };
export default oracle;
