import {
  assertEqual,
  assertStage,
  cloneActual,
  type SotaFunctionalActual,
  type SotaOracle,
  type SotaStageActual,
} from '../../oracle-types.js';

interface InventoryRecord {
  available_units: number;
  location: string;
}

function expected(input: Parameters<SotaOracle['expected']>[0]): SotaFunctionalActual {
  const orderId = String(input.domain.order_id);
  const sku = String(input.domain.sku);
  const requestedUnits = Number(input.domain.requested_units);
  const inventory = lookupInventory(sku);
  const reserved = requestedUnits > 0 && inventory.available_units >= requestedUnits;
  const reservedUnits = reserved ? requestedUnits : 0;
  const backorderUnits = Math.max(0, requestedUnits - inventory.available_units);
  return {
    final_stage: 'complete',
    domain: {},
    stages: {
      inventory_lookup: stage('inventory_lookup', {
        stage: 'inventory_lookup',
        adapter_kind: 'in_memory_mock',
        sku,
        available_units: inventory.available_units,
        location: inventory.location,
        checked_at: input.runtime?.now_iso ?? '2026-06-29T07:00:00.000Z',
      }, [`sku:${sku}`, `available_units:${inventory.available_units}`]),
      reservation_decision: stage('reservation_decision', {
        stage: 'reservation_decision',
        order_id: orderId,
        sku,
        requested_units: requestedUnits,
        reserved,
        reserved_units: reservedUnits,
        backorder_units: backorderUnits,
        reason: reserved ? 'stock_available' : 'insufficient_stock',
      }, [`reserved:${reserved}`, `reserved_units:${reservedUnits}`, `backorder_units:${backorderUnits}`]),
    },
  };
}

function assertOutput(input: Parameters<SotaOracle['assertOutput']>[0], actual: SotaFunctionalActual): void {
  const want = expected(input);
  assertEqual(actual.final_stage, want.final_stage, 'final_stage');
  for (const stageName of ['inventory_lookup', 'reservation_decision']) {
    assertEqual(assertStage(actual, stageName).result, want.stages[stageName].result, `${stageName}.result`);
    assertEqual(assertStage(actual, stageName).items, want.stages[stageName].items, `${stageName}.items`);
  }
  assertEqual(assertStage(actual, 'inventory_lookup').raw.adapter_kind, 'in_memory_mock', 'inventory_lookup.raw.adapter_kind');
  assertEqual(
    assertStage(actual, 'reservation_decision').result.sku,
    assertStage(actual, 'inventory_lookup').result.sku,
    'cross-stage sku',
  );
}

function mutations(_input: Parameters<SotaOracle['mutations']>[0], good: SotaFunctionalActual): SotaFunctionalActual[] {
  const realAdapter = cloneActual(good);
  realAdapter.stages.inventory_lookup.result.adapter_kind = 'repo_integration';
  realAdapter.stages.inventory_lookup.raw.adapter_kind = 'repo_integration';
  const wrongDecision = cloneActual(good);
  wrongDecision.stages.reservation_decision.result.reserved = false;
  const wrongBackorder = cloneActual(good);
  wrongBackorder.stages.reservation_decision.result.backorder_units = 3;
  return [realAdapter, wrongDecision, wrongBackorder];
}

function lookupInventory(sku: string): InventoryRecord {
  if (sku === 'SKU-RED-5') return { available_units: 8, location: 'A2' };
  if (sku === 'SKU-BLUE-9') return { available_units: 0, location: 'B1' };
  return { available_units: 0, location: 'UNKNOWN' };
}

function stage(stageName: string, result: Record<string, unknown>, items: unknown[]): SotaStageActual {
  const raw: SotaStageActual['raw'] = { result_json: JSON.stringify(result), items_json: JSON.stringify(items), digest: '' };
  if (result.adapter_kind) raw.adapter_kind = String(result.adapter_kind);
  return { stage: stageName, result, items, raw };
}

const oracle: SotaOracle = { expected, assertOutput, mutations };
export { assertOutput, expected, mutations };
export default oracle;
