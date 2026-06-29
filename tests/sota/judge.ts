import type { SotaBenchmark } from './harness.js';
import type { AdvisoryJudgeResult, SotaBenchmarkResult } from './score.js';

export interface AdvisoryJudgeConfig {
  providerUrl: string;
  model: string;
}

export async function runAdvisoryJudge(
  benchmark: SotaBenchmark,
  result: SotaBenchmarkResult,
  config: AdvisoryJudgeConfig,
): Promise<AdvisoryJudgeResult> {
  const started = Date.now();
  try {
    const response = await fetch(`${config.providerUrl.replace(/\/+$/u, '')}/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${process.env.PGAS_OPENAI_API_KEY ?? process.env.OPENAI_API_KEY ?? 'local'}`,
      },
      body: JSON.stringify({
        model: config.model,
        temperature: 0,
        messages: [
          {
            role: 'system',
            content: 'Return compact JSON only: {"rubric_scores":{"correctness":0-5,"specificity":0-5,"safety":0-5},"summary":"short"}. This is advisory and never gating.',
          },
          {
            role: 'user',
            content: [
              `Benchmark: ${benchmark.slug}`,
              `Rubric:\n${benchmark.rubric}`,
              `Deterministic result:\n${JSON.stringify({
                passed: result.passed,
                failure_taxonomy: result.failure_taxonomy,
                gates: result.gates,
                body_hashes: result.body_hashes,
              }, null, 2)}`,
            ].join('\n\n'),
          },
        ],
      }),
    });
    if (!response.ok) {
      throw new Error(`advisory judge provider failed: HTTP ${response.status}`);
    }
    const json = await response.json() as { choices?: Array<{ message?: { content?: string } }> };
    const content = json.choices?.[0]?.message?.content;
    if (!content) {
      throw new Error('advisory judge provider returned no content');
    }
    const parsed = parseJudgeJson(content);
    return {
      status: 'pass',
      model_id: config.model,
      rubric_scores: parsed.rubric_scores,
      summary: parsed.summary,
      latency_ms: Date.now() - started,
    };
  } catch (error) {
    return {
      status: 'error',
      model_id: config.model,
      error: error instanceof Error ? error.message : String(error),
      latency_ms: Date.now() - started,
    };
  }
}

function parseJudgeJson(content: string): { rubric_scores: Record<string, number>; summary: string } {
  const fence = content.match(/```(?:json)?\s*([\s\S]*?)```/u);
  const parsed = JSON.parse((fence?.[1] ?? content).trim()) as {
    rubric_scores?: Record<string, unknown>;
    summary?: unknown;
  };
  return {
    rubric_scores: Object.fromEntries(Object.entries(parsed.rubric_scores ?? {}).map(([key, value]) => [key, Number(value)])),
    summary: typeof parsed.summary === 'string' ? parsed.summary : '',
  };
}
