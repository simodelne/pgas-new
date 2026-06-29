import {
  assertEqual,
  assertStage,
  cloneActual,
  type SotaFunctionalActual,
  type SotaOracle,
  type SotaStageActual,
} from '../../oracle-types.js';

function expected(input: Parameters<SotaOracle['expected']>[0]): SotaFunctionalActual {
  const orderId = String(input.domain.order_id);
  const originalAmount = Number(input.domain.original_amount_cents);
  const deliveredDaysAgo = Number(input.domain.delivered_days_ago);
  const refundRequested = input.domain.refund_requested === true;
  const policy = refundPolicy(refundRequested, deliveredDaysAgo);
  const refundCents = Math.round(originalAmount * policy.refund_pct / 100);
  const postingType = refundCents > 0 ? 'refund' : 'no_refund';
  return {
    final_stage: 'complete',
    domain: {},
    stages: {
      normalize_refund: stage('normalize_refund', {
        stage: 'normalize_refund',
        order_id: orderId,
        original_amount_cents: originalAmount,
        refund_requested: refundRequested,
      }, [`order:${orderId}`, `amount_cents:${originalAmount}`]),
      apply_refund_policy: stage('apply_refund_policy', {
        stage: 'apply_refund_policy',
        order_id: orderId,
        delivered_days_ago: deliveredDaysAgo,
        refund_pct: policy.refund_pct,
        refund_cents: refundCents,
        policy_code: policy.policy_code,
      }, [`policy:${policy.policy_code}`, `refund_cents:${refundCents}`]),
      ledger_posting: stage('ledger_posting', {
        stage: 'ledger_posting',
        order_id: orderId,
        posting_type: postingType,
        amount_cents: refundCents,
        source_policy: policy.policy_code,
      }, [`posting:${postingType}`, `amount_cents:${refundCents}`]),
    },
  };
}

function assertOutput(input: Parameters<SotaOracle['assertOutput']>[0], actual: SotaFunctionalActual): void {
  const want = expected(input);
  assertEqual(actual.final_stage, want.final_stage, 'final_stage');
  for (const stageName of ['normalize_refund', 'apply_refund_policy', 'ledger_posting']) {
    assertEqual(assertStage(actual, stageName).result, want.stages[stageName].result, `${stageName}.result`);
    assertEqual(assertStage(actual, stageName).items, want.stages[stageName].items, `${stageName}.items`);
  }
  assertEqual(
    assertStage(actual, 'ledger_posting').result.amount_cents,
    assertStage(actual, 'apply_refund_policy').result.refund_cents,
    'cross-stage ledger amount',
  );
  assertEqual(
    assertStage(actual, 'ledger_posting').result.source_policy,
    assertStage(actual, 'apply_refund_policy').result.policy_code,
    'cross-stage ledger policy',
  );
}

function mutations(_input: Parameters<SotaOracle['mutations']>[0], good: SotaFunctionalActual): SotaFunctionalActual[] {
  const wrongPct = cloneActual(good);
  wrongPct.stages.apply_refund_policy.result.refund_pct = 100;
  const brokenLedgerAmount = cloneActual(good);
  brokenLedgerAmount.stages.ledger_posting.result.amount_cents = 12500;
  const brokenLedgerPolicy = cloneActual(good);
  brokenLedgerPolicy.stages.ledger_posting.result.source_policy = 'full_refund_window';
  return [wrongPct, brokenLedgerAmount, brokenLedgerPolicy];
}

function refundPolicy(refundRequested: boolean, deliveredDaysAgo: number): { refund_pct: number; policy_code: string } {
  if (!refundRequested) return { refund_pct: 0, policy_code: 'no_request' };
  if (deliveredDaysAgo <= 30) return { refund_pct: 100, policy_code: 'full_refund_window' };
  if (deliveredDaysAgo <= 60) return { refund_pct: 50, policy_code: 'partial_refund_window' };
  return { refund_pct: 0, policy_code: 'outside_refund_window' };
}

function stage(stageName: string, result: Record<string, unknown>, items: unknown[]): SotaStageActual {
  return { stage: stageName, result, items, raw: { result_json: JSON.stringify(result), items_json: JSON.stringify(items), digest: '' } };
}

const oracle: SotaOracle = { expected, assertOutput, mutations };
export { assertOutput, expected, mutations };
export default oracle;
