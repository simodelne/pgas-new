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
  const queue = score >= 90 ? 'security-escalation' : score >= 60 ? 'risk-ops' : 'standard-support';
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
      }, [`risk_score:${score}`]),
      route_queue: stage('route_queue', {
        stage: 'route_queue',
        risk_score: score,
        owner_queue: queue,
        sla_minutes: queue === 'security-escalation' ? 15 : queue === 'risk-ops' ? 60 : 240,
      }, [`queue:${queue}`, `sla:${queue === 'security-escalation' ? 15 : queue === 'risk-ops' ? 60 : 240}`]),
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
  wrongQueue.stages.route_queue.result.owner_queue = 'standard-support';
  const wrongScore = cloneActual(good);
  wrongScore.stages.score_risk.result.risk_score = 50;
  return [wrongQueue, wrongScore];
}

function riskScore(domain: Record<string, unknown>): number {
  const severity = domain.severity === 'high' ? 45 : domain.severity === 'medium' ? 25 : 10;
  const tier = domain.customer_tier === 'enterprise' ? 25 : 5;
  const failedLogins = Math.min(Number(domain.failed_logins ?? 0) * 3, 20);
  const exposure = domain.data_exposure === true ? 20 : 0;
  return Math.min(100, severity + tier + failedLogins + exposure);
}

function stage(stageName: string, result: Record<string, unknown>, items: unknown[]): SotaStageActual {
  return { stage: stageName, result, items, raw: { result_json: JSON.stringify(result), items_json: JSON.stringify(items), digest: '' } };
}

const oracle: SotaOracle = { expected, assertOutput, mutations };
export { assertOutput, expected, mutations };
export default oracle;
