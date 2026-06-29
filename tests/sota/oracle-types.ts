export interface SotaBenchmarkInput {
  id: string;
  prompt: string;
  domain: Record<string, unknown>;
  runtime?: {
    now_iso?: string;
    random?: number;
  };
  llm_outputs?: Record<string, {
    result_json: string;
    items_json: string;
  }>;
}

export interface SotaStageActual {
  stage: string;
  result: Record<string, unknown>;
  items: unknown[];
  raw: {
    result_json: string;
    items_json: string;
    digest?: string;
    adapter_kind?: string;
  };
}

export interface SotaFunctionalActual {
  final_stage: string;
  stages: Record<string, SotaStageActual>;
  domain: Record<string, unknown>;
}

export interface SotaOracle {
  expected(input: SotaBenchmarkInput): SotaFunctionalActual;
  assertOutput(input: SotaBenchmarkInput, actual: SotaFunctionalActual): void;
  mutations(input: SotaBenchmarkInput, expected: SotaFunctionalActual): SotaFunctionalActual[];
}

export function cloneActual(actual: SotaFunctionalActual): SotaFunctionalActual {
  return JSON.parse(JSON.stringify(actual)) as SotaFunctionalActual;
}

export function assertEqual(actual: unknown, expected: unknown, label: string): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

export function assertStage(actual: SotaFunctionalActual, stage: string): SotaStageActual {
  const value = actual.stages[stage];
  if (!value) {
    throw new Error(`missing stage output: ${stage}`);
  }
  return value;
}
