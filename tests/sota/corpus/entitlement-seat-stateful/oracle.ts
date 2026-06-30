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
  const currentSeats = Number(input.domain.current_seats);
  const requestedSeats = Number(input.domain.requested_seats);
  const entitlement = lookupEntitlement(accountId);
  const seatDelta = requestedSeats - currentSeats;
  const approved = entitlement.active_contract && requestedSeats <= entitlement.max_seats;
  const reason = approved
    ? 'capacity_available'
    : entitlement.active_contract
      ? 'entitlement_limit_exceeded'
      : 'inactive_contract';
  const auditAction = approved ? 'approve_seat_change' : 'route_to_success';
  const finalSeats = approved ? requestedSeats : currentSeats;
  return {
    final_stage: 'complete',
    domain: {},
    stages: {
      entitlement_lookup: stage('entitlement_lookup', {
        stage: 'entitlement_lookup',
        adapter_kind: 'in_memory_mock',
        account_id: accountId,
        tier: entitlement.tier,
        max_seats: entitlement.max_seats,
        active_contract: entitlement.active_contract,
        mocked_at: input.runtime?.now_iso ?? '2026-06-29T00:00:00.000Z',
      }, [`account:${accountId}`, `tier:${entitlement.tier}`, `max_seats:${entitlement.max_seats}`], 'in_memory_mock'),
      seat_delta_policy: stage('seat_delta_policy', {
        stage: 'seat_delta_policy',
        account_id: accountId,
        current_seats: currentSeats,
        requested_seats: requestedSeats,
        seat_delta: seatDelta,
        approved,
        reason,
      }, [`approved:${approved}`, `seat_delta:${seatDelta}`]),
      audit_decision: stage('audit_decision', {
        stage: 'audit_decision',
        account_id: accountId,
        audit_action: auditAction,
        final_seats: finalSeats,
        source_reason: reason,
      }, [`action:${auditAction}`, `final_seats:${finalSeats}`]),
    },
  };
}

function assertOutput(input: Parameters<SotaOracle['assertOutput']>[0], actual: SotaFunctionalActual): void {
  const want = expected(input);
  assertEqual(actual.final_stage, want.final_stage, 'final_stage');
  for (const stageName of ['entitlement_lookup', 'seat_delta_policy', 'audit_decision']) {
    assertEqual(assertStage(actual, stageName).result, want.stages[stageName].result, `${stageName}.result`);
    assertEqual(assertStage(actual, stageName).items, want.stages[stageName].items, `${stageName}.items`);
  }
  assertEqual(
    assertStage(actual, 'seat_delta_policy').result.account_id,
    assertStage(actual, 'entitlement_lookup').result.account_id,
    'cross-stage account',
  );
  assertEqual(
    assertStage(actual, 'audit_decision').result.source_reason,
    assertStage(actual, 'seat_delta_policy').result.reason,
    'cross-stage audit reason',
  );
}

function mutations(_input: Parameters<SotaOracle['mutations']>[0], good: SotaFunctionalActual): SotaFunctionalActual[] {
  const brokenApproval = cloneActual(good);
  brokenApproval.stages.seat_delta_policy.result.approved = false;
  const wrongFinalSeats = cloneActual(good);
  wrongFinalSeats.stages.audit_decision.result.final_seats = 50;
  const wrongAdapter = cloneActual(good);
  wrongAdapter.stages.entitlement_lookup.result.adapter_kind = 'repo_integration';
  wrongAdapter.stages.entitlement_lookup.raw.adapter_kind = 'repo_integration';
  return [brokenApproval, wrongFinalSeats, wrongAdapter];
}

function lookupEntitlement(accountId: string): { tier: string; max_seats: number; active_contract: boolean } {
  if (accountId === 'acct-2002') {
    return { tier: 'growth', max_seats: 75, active_contract: true };
  }
  return { tier: 'unknown', max_seats: 0, active_contract: false };
}

function stage(
  stageName: string,
  result: Record<string, unknown>,
  items: unknown[],
  adapterKind?: string,
): SotaStageActual {
  const raw: SotaStageActual['raw'] = {
    result_json: JSON.stringify(result),
    items_json: JSON.stringify(items),
    digest: '',
    ...(adapterKind ? { adapter_kind: adapterKind } : {}),
  };
  return { stage: stageName, result, items, raw };
}

const oracle: SotaOracle = { expected, assertOutput, mutations };
export { assertOutput, expected, mutations };
export default oracle;
