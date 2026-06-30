import {
  assertEqual,
  assertStage,
  cloneActual,
  type SotaFunctionalActual,
  type SotaOracle,
  type SotaStageActual,
} from '../../oracle-types.js';

function expected(input: Parameters<SotaOracle['expected']>[0]): SotaFunctionalActual {
  const plan = String(input.domain.plan);
  const seats = Number(input.domain.seats);
  const region = String(input.domain.region);
  const base = plan === 'enterprise' ? 500 : plan === 'pro' ? 100 : 40;
  const seatRate = plan === 'enterprise' ? 12 : plan === 'pro' ? 7 : 5;
  const subtotal = base + seats * seatRate;
  const multiplier = region === 'eu' ? 1.2 : 1;
  const total = Math.round(subtotal * multiplier);
  return {
    final_stage: 'complete',
    domain: {},
    stages: {
      calculate_fee: stage('calculate_fee', {
        stage: 'calculate_fee',
        plan,
        seats,
        region,
        base_usd: base,
        seat_rate_usd: seatRate,
        subtotal_usd: subtotal,
        region_multiplier: multiplier,
        total_usd: total,
        currency: 'USD',
        priced_at: input.runtime?.now_iso ?? '2026-06-29T00:00:00.000Z',
      }, [`plan:${plan}`, `seats:${seats}`, `total_usd:${total}`]),
    },
  };
}

function assertOutput(input: Parameters<SotaOracle['assertOutput']>[0], actual: SotaFunctionalActual): void {
  const want = expected(input);
  assertEqual(actual.final_stage, want.final_stage, 'final_stage');
  assertEqual(assertStage(actual, 'calculate_fee').result, want.stages.calculate_fee.result, 'calculate_fee.result');
  assertEqual(assertStage(actual, 'calculate_fee').items, want.stages.calculate_fee.items, 'calculate_fee.items');
}

function mutations(input: Parameters<SotaOracle['mutations']>[0], good: SotaFunctionalActual): SotaFunctionalActual[] {
  const wrongTotal = cloneActual(good);
  wrongTotal.stages.calculate_fee.result.total_usd = Number(wrongTotal.stages.calculate_fee.result.total_usd) + 1;
  const wrongFinal = cloneActual(good);
  wrongFinal.final_stage = 'calculate_fee';
  const emptyItems = cloneActual(good);
  emptyItems.stages.calculate_fee.items = [];
  void input;
  return [wrongTotal, wrongFinal, emptyItems];
}

function stage(stageName: string, result: Record<string, unknown>, items: unknown[]): SotaStageActual {
  return {
    stage: stageName,
    result,
    items,
    raw: {
      result_json: JSON.stringify(result),
      items_json: JSON.stringify(items),
      digest: '',
    },
  };
}

const oracle: SotaOracle = { expected, assertOutput, mutations };
export { assertOutput, expected, mutations };
export default oracle;
