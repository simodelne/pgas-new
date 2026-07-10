import {
  assertEqual,
  assertStage,
  cloneActual,
  type SotaFunctionalActual,
  type SotaOracle,
  type SotaStageActual,
} from '../../oracle-types.js';

// approval_summary is a DETERMINISTIC pure-compute stage (its domain-spec is a
// threshold check: approved = discounted_total <= budget). The foundry classifies
// it pure-compute (correctly, per the determinism-debias), so it emits a computed
// body whose output lands at approval_summary.output.result_json — this oracle
// verifies that deterministic computation rather than an llm-reasoning projection.
function expected(input: Parameters<SotaOracle['expected']>[0]): SotaFunctionalActual {
  const subtotal = Number(input.domain.base_hours) * Number(input.domain.hourly_rate_usd);
  const discounted = Math.round(subtotal * (1 - Number(input.domain.discount_pct) / 100));
  const budget = Number(input.domain.budget_usd);
  const approved = discounted <= budget;
  const basis = approved ? 'discounted_total_within_budget' : 'discounted_total_exceeds_budget';
  return {
    final_stage: 'complete',
    domain: {},
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
      approval_summary: stage('approval_summary', {
        stage: 'approval_summary',
        approved,
        basis,
        discounted_total_usd: discounted,
        budget_usd: budget,
      }, [`approved:${approved}`, `discounted_total_usd:${discounted}`]),
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
}

function mutations(_input: Parameters<SotaOracle['mutations']>[0], good: SotaFunctionalActual): SotaFunctionalActual[] {
  const brokenDependency = cloneActual(good);
  brokenDependency.stages.apply_discount.result.previous_total_usd = 999;
  const wrongApproval = cloneActual(good);
  wrongApproval.stages.approval_summary.result.approved = !(wrongApproval.stages.approval_summary.result.approved as boolean);
  return [brokenDependency, wrongApproval];
}

function stage(stageName: string, result: Record<string, unknown>, items: unknown[]): SotaStageActual {
  return { stage: stageName, result, items, raw: { result_json: JSON.stringify(result), items_json: JSON.stringify(items), digest: '' } };
}

const oracle: SotaOracle = { expected, assertOutput, mutations };
export { assertOutput, expected, mutations };
export default oracle;
