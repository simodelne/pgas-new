import {
  assertEqual,
  assertStage,
  cloneActual,
  type SotaFunctionalActual,
  type SotaOracle,
  type SotaStageActual,
} from '../../oracle-types.js';

function expected(input: Parameters<SotaOracle['expected']>[0]): SotaFunctionalActual {
  const score = riskScore(input.domain);
  const queue = ownerQueue(score, input.domain);
  return {
    final_stage: 'complete',
    domain: {},
    stages: {
      score_risk: stage('score_risk', {
        stage: 'score_risk',
        risk_score: score,
        severity: input.domain.severity,
        factors: ['severity', 'customer_tier', 'failed_logins', 'data_exposure'],
        scored_at: input.runtime?.now_iso ?? '2026-06-29T01:00:00.000Z',
      }, [`risk_score:${score}`, `severity:${String(input.domain.severity)}`]),
      route_queue: stage('route_queue', {
        stage: 'route_queue',
        risk_score: score,
        owner_queue: queue,
        route_reason: routeReason(score, input.domain),
      }, [`owner_queue:${queue}`, `risk_score:${score}`]),
    },
  };
}

function assertOutput(input: Parameters<SotaOracle['assertOutput']>[0], actual: SotaFunctionalActual): void {
  const want = expected(input);
  assertEqual(actual.final_stage, 'complete', 'final_stage');
  for (const stageName of ['score_risk', 'route_queue']) {
    assertEqual(assertStage(actual, stageName).result, want.stages[stageName].result, `${stageName}.result`);
    assertEqual(assertStage(actual, stageName).items, want.stages[stageName].items, `${stageName}.items`);
  }
}

function mutations(_input: Parameters<SotaOracle['mutations']>[0], good: SotaFunctionalActual): SotaFunctionalActual[] {
  const wrongQueue = cloneActual(good);
  wrongQueue.stages.route_queue.result.owner_queue = 'standard_ops';
  const wrongScore = cloneActual(good);
  wrongScore.stages.score_risk.result.risk_score = 50;
  const wrongItems = cloneActual(good);
  wrongItems.stages.route_queue.items = ['queue:security_escalation', 'sla:15'];
  const wrongReason = cloneActual(good);
  wrongReason.stages.route_queue.result.route_reason = 'enterprise_data_exposure';
  return [wrongQueue, wrongScore, wrongItems, wrongReason];
}

function riskScore(domain: Record<string, unknown>): number {
  const severity = domain.severity === 'critical' ? 90 : domain.severity === 'high' ? 70 : domain.severity === 'medium' ? 50 : 20;
  const tier = domain.customer_tier === 'enterprise' ? 15 : 0;
  const failedLogins = Number(domain.failed_logins ?? 0) >= 5 ? 15 : 0;
  const exposure = domain.data_exposure === true ? 15 : 0;
  return Math.min(100, severity + tier + failedLogins + exposure);
}

function ownerQueue(score: number, domain: Record<string, unknown>): string {
  if (score >= 90) return 'security_escalation';
  if (domain.customer_tier === 'enterprise' && domain.data_exposure === true) return 'security_escalation';
  if (score >= 60) return 'risk_review';
  return 'standard_ops';
}

function routeReason(score: number, domain: Record<string, unknown>): string {
  if (score >= 90) return 'risk_score_at_least_90';
  if (domain.customer_tier === 'enterprise' && domain.data_exposure === true) return 'enterprise_data_exposure';
  if (score >= 60) return 'risk_score_at_least_60';
  return 'risk_score_below_60';
}

function stage(stageName: string, result: Record<string, unknown>, items: unknown[]): SotaStageActual {
  return { stage: stageName, result, items, raw: { result_json: JSON.stringify(result), items_json: JSON.stringify(items), digest: '' } };
}

const oracle: SotaOracle = { expected, assertOutput, mutations };
export { assertOutput, expected, mutations };
export default oracle;
