import {
  assertEqual,
  assertStage,
  cloneActual,
  type SotaFunctionalActual,
  type SotaOracle,
  type SotaStageActual,
} from '../../oracle-types.js';

function expected(input: Parameters<SotaOracle['expected']>[0]): SotaFunctionalActual {
  const invoiceId = String(input.domain.invoice_id);
  const subtotalCents = Number(input.domain.subtotal_cents);
  const defectUnits = Number(input.domain.defect_units);
  const unitCreditCents = Number(input.domain.unit_credit_cents);
  const requestedCredit = input.domain.requested_credit === true;
  const eligibleUnits = requestedCredit ? defectUnits : 0;
  const creditCents = requestedCredit ? Math.min(subtotalCents, defectUnits * unitCreditCents) : 0;
  const reasonCode = !requestedCredit
    ? 'no_request'
    : creditCents > 0
      ? 'defect_credit_applied'
      : 'no_defects';
  const postingType = creditCents > 0 ? 'credit_memo' : 'no_credit';
  return {
    final_stage: 'complete',
    domain: {},
    stages: {
      normalize_credit: stage('normalize_credit', {
        stage: 'normalize_credit',
        invoice_id: invoiceId,
        subtotal_cents: subtotalCents,
        defect_units: defectUnits,
        unit_credit_cents: unitCreditCents,
        requested_credit: requestedCredit,
      }, [`invoice:${invoiceId}`, `defect_units:${defectUnits}`]),
      calculate_credit: stage('calculate_credit', {
        stage: 'calculate_credit',
        invoice_id: invoiceId,
        eligible_units: eligibleUnits,
        unit_credit_cents: unitCreditCents,
        credit_cents: creditCents,
        reason_code: reasonCode,
      }, [`credit_cents:${creditCents}`, `reason:${reasonCode}`]),
      memo_posting: stage('memo_posting', {
        stage: 'memo_posting',
        invoice_id: invoiceId,
        posting_type: postingType,
        amount_cents: creditCents,
        source_reason: reasonCode,
      }, [`posting:${postingType}`, `amount_cents:${creditCents}`]),
    },
  };
}

function assertOutput(input: Parameters<SotaOracle['assertOutput']>[0], actual: SotaFunctionalActual): void {
  const want = expected(input);
  assertEqual(actual.final_stage, want.final_stage, 'final_stage');
  for (const stageName of ['normalize_credit', 'calculate_credit', 'memo_posting']) {
    assertEqual(assertStage(actual, stageName).result, want.stages[stageName].result, `${stageName}.result`);
    assertEqual(assertStage(actual, stageName).items, want.stages[stageName].items, `${stageName}.items`);
  }
  assertEqual(
    assertStage(actual, 'memo_posting').result.amount_cents,
    assertStage(actual, 'calculate_credit').result.credit_cents,
    'cross-stage memo amount',
  );
  assertEqual(
    assertStage(actual, 'memo_posting').result.source_reason,
    assertStage(actual, 'calculate_credit').result.reason_code,
    'cross-stage memo reason',
  );
}

function mutations(_input: Parameters<SotaOracle['mutations']>[0], good: SotaFunctionalActual): SotaFunctionalActual[] {
  const uncappedCredit = cloneActual(good);
  uncappedCredit.stages.calculate_credit.result.credit_cents = 12500;
  const recomputedPosting = cloneActual(good);
  recomputedPosting.stages.memo_posting.result.amount_cents = 5000;
  const wrongReason = cloneActual(good);
  wrongReason.stages.memo_posting.result.source_reason = 'manual_override';
  return [uncappedCredit, recomputedPosting, wrongReason];
}

function stage(stageName: string, result: Record<string, unknown>, items: unknown[]): SotaStageActual {
  return { stage: stageName, result, items, raw: { result_json: JSON.stringify(result), items_json: JSON.stringify(items), digest: '' } };
}

const oracle: SotaOracle = { expected, assertOutput, mutations };
export { assertOutput, expected, mutations };
export default oracle;
