import {
  assertEqual,
  assertStage,
  cloneActual,
  type SotaFunctionalActual,
  type SotaOracle,
  type SotaStageActual,
} from '../../oracle-types.js';

interface Pricing {
  base_cents: number;
  included_events: number;
  overage_rate_cents: number;
}

function expected(input: Parameters<SotaOracle['expected']>[0]): SotaFunctionalActual {
  const plan = String(input.domain.plan);
  const usageEvents = Number(input.domain.usage_events);
  const pricing = pricingFor(plan);
  const overageEvents = Math.max(0, usageEvents - pricing.included_events);
  const overageCents = overageEvents * pricing.overage_rate_cents;
  const totalCents = pricing.base_cents + overageCents;
  return {
    final_stage: 'complete',
    domain: {},
    stages: {
      calculate_invoice: stage('calculate_invoice', {
        stage: 'calculate_invoice',
        plan,
        usage_events: usageEvents,
        included_events: pricing.included_events,
        overage_events: overageEvents,
        base_cents: pricing.base_cents,
        overage_rate_cents: pricing.overage_rate_cents,
        overage_cents: overageCents,
        total_cents: totalCents,
        currency: 'USD',
        billed_at: input.runtime?.now_iso ?? '2026-06-29T05:00:00.000Z',
      }, [`plan:${plan}`, `overage_events:${overageEvents}`, `total_cents:${totalCents}`]),
    },
  };
}

function assertOutput(input: Parameters<SotaOracle['assertOutput']>[0], actual: SotaFunctionalActual): void {
  const want = expected(input);
  assertEqual(actual.final_stage, want.final_stage, 'final_stage');
  assertEqual(assertStage(actual, 'calculate_invoice').result, want.stages.calculate_invoice.result, 'calculate_invoice.result');
  assertEqual(assertStage(actual, 'calculate_invoice').items, want.stages.calculate_invoice.items, 'calculate_invoice.items');
}

function mutations(_input: Parameters<SotaOracle['mutations']>[0], good: SotaFunctionalActual): SotaFunctionalActual[] {
  const wrongTotal = cloneActual(good);
  wrongTotal.stages.calculate_invoice.result.total_cents = Number(wrongTotal.stages.calculate_invoice.result.total_cents) + 100;
  const wrongOverage = cloneActual(good);
  wrongOverage.stages.calculate_invoice.result.overage_events = 0;
  const wrongItems = cloneActual(good);
  wrongItems.stages.calculate_invoice.items = ['plan:growth', 'total_cents:10400'];
  return [wrongTotal, wrongOverage, wrongItems];
}

function pricingFor(plan: string): Pricing {
  if (plan === 'scale') return { base_cents: 20000, included_events: 20000, overage_rate_cents: 1 };
  if (plan === 'growth') return { base_cents: 8000, included_events: 5000, overage_rate_cents: 2 };
  return { base_cents: 2500, included_events: 1000, overage_rate_cents: 3 };
}

function stage(stageName: string, result: Record<string, unknown>, items: unknown[]): SotaStageActual {
  return { stage: stageName, result, items, raw: { result_json: JSON.stringify(result), items_json: JSON.stringify(items), digest: '' } };
}

const oracle: SotaOracle = { expected, assertOutput, mutations };
export { assertOutput, expected, mutations };
export default oracle;
