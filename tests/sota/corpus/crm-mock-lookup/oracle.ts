import {
  assertEqual,
  assertStage,
  cloneActual,
  type SotaFunctionalActual,
  type SotaOracle,
  type SotaStageActual,
} from '../../oracle-types.js';

function expected(input: Parameters<SotaOracle['expected']>[0]): SotaFunctionalActual {
  const accountId = String(input.domain.account_id);
  const requestedSeats = Number(input.domain.requested_seats);
  const eligible = requestedSeats <= 50;
  return {
    final_stage: 'complete',
    domain: {},
    stages: {
      crm_lookup: stage('crm_lookup', {
        stage: 'crm_lookup',
        adapter_kind: 'in_memory_mock',
        account_id: accountId,
        tier: 'gold',
        active_contract: true,
        mocked_at: input.runtime?.now_iso ?? '2026-06-29T04:00:00.000Z',
      }, [`account:${accountId}`, 'tier:gold']),
      eligibility_score: stage('eligibility_score', {
        stage: 'eligibility_score',
        account_id: accountId,
        requested_seats: requestedSeats,
        eligible,
        reason: eligible ? 'gold_tier_capacity_available' : 'requested_seats_exceed_mock_capacity',
      }, [`eligible:${eligible}`]),
    },
  };
}

function assertOutput(input: Parameters<SotaOracle['assertOutput']>[0], actual: SotaFunctionalActual): void {
  const want = expected(input);
  assertEqual(actual.final_stage, want.final_stage, 'final_stage');
  for (const stageName of ['crm_lookup', 'eligibility_score']) {
    assertEqual(assertStage(actual, stageName).result, want.stages[stageName].result, `${stageName}.result`);
    assertEqual(assertStage(actual, stageName).items, want.stages[stageName].items, `${stageName}.items`);
  }
}

function mutations(_input: Parameters<SotaOracle['mutations']>[0], good: SotaFunctionalActual): SotaFunctionalActual[] {
  const realAdapter = cloneActual(good);
  realAdapter.stages.crm_lookup.result.adapter_kind = 'repo_integration';
  const wrongEligibility = cloneActual(good);
  wrongEligibility.stages.eligibility_score.result.eligible = false;
  return [realAdapter, wrongEligibility];
}

function stage(stageName: string, result: Record<string, unknown>, items: unknown[]): SotaStageActual {
  const raw: SotaStageActual['raw'] = { result_json: JSON.stringify(result), items_json: JSON.stringify(items), digest: '' };
  if (result.adapter_kind) raw.adapter_kind = String(result.adapter_kind);
  return { stage: stageName, result, items, raw };
}

const oracle: SotaOracle = { expected, assertOutput, mutations };
export { assertOutput, expected, mutations };
export default oracle;
