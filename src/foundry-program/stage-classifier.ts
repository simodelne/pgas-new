export type StageArchetype = 'pure-compute' | 'llm-reasoning' | 'external-adapter';

export interface ClassifiedStage {
  slug: string;
  archetype: StageArchetype;
  rationale: string;
  adapter_kind?: 'in_memory_mock';
}

interface StageInput {
  slug: string;
  is_bootstrap?: boolean;
  is_terminal?: boolean;
}

const EXTERNAL_TERMS = [
  'api',
  'adapter',
  'calendar',
  'crm',
  'database',
  'db',
  'email',
  'fetch',
  'github',
  'http',
  'integration',
  'jira',
  'lookup',
  'notify',
  'publish',
  'scrape',
  'service',
  'slack',
  'webhook',
] as const;

const LLM_REASONING_TERMS = [
  'analysis',
  'classify',
  'critique',
  'draft',
  'judge',
  'narrative',
  'reason',
  'recommend',
  'review',
  'summarize',
  'summary',
] as const;

const COMPUTE_TERMS = [
  'aggregate',
  'assemble',
  'calculate',
  'compute',
  'estimate',
  'fee',
  'format',
  'model',
  'score',
  'validate',
] as const;

export function classifyStagesForDomain(domain: Record<string, unknown>): ClassifiedStage[] {
  const stages = parseStages(domain);
  const purpose = stringDomainField(domain, 'intake.purpose') ?? '';
  const delegation = parseOptionalJsonObject(domain, 'intake.delegation_json');

  return stages.map((stage) => classifyStage(stage, purpose, delegation));
}

function classifyStage(
  stage: StageInput,
  purpose: string,
  delegation: Record<string, unknown>,
): ClassifiedStage {
  const slug = stage.slug;
  const localStageText = [
    slug,
    words(slug),
  ].join(' ').toLowerCase();
  const externalStageText = [
    localStageText,
    JSON.stringify(delegation[slug] ?? ''),
  ].join(' ').toLowerCase();
  void purpose;

  if (hasAny(externalStageText, EXTERNAL_TERMS) || hasExternalDelegation(delegation[slug])) {
    return {
      slug,
      archetype: 'external-adapter',
      adapter_kind: 'in_memory_mock',
      rationale: `external adapter: ${slug} references an integration/service boundary, so synthesis emits an in-memory mock.`,
    };
  }

  if (hasAny(localStageText, LLM_REASONING_TERMS) && !hasAny(localStageText, COMPUTE_TERMS)) {
    return {
      slug,
      archetype: 'llm-reasoning',
      rationale: `llm reasoning: ${slug} is framed as natural-language reasoning, classification, drafting, review, or summary work.`,
    };
  }

  return {
    slug,
    archetype: 'pure-compute',
    rationale: `pure compute: ${slug} can be implemented as deterministic local logic against the frozen stage contract.`,
  };
}

function parseStages(domain: Record<string, unknown>): StageInput[] {
  const raw = stringDomainField(domain, 'intake.stages_json');
  if (!raw) {
    throw new Error('missing JSON-string domain field: intake.stages_json');
  }
  const parsed = JSON.parse(raw) as unknown;
  if (!Array.isArray(parsed)) {
    throw new Error('intake.stages_json must decode to an array');
  }
  return parsed.map((stage, index) => {
    if (typeof stage === 'string') {
      return {
        slug: stage,
        ...(index === 0 ? { is_bootstrap: true } : {}),
        ...(index === parsed.length - 1 ? { is_terminal: true } : {}),
      };
    }
    if (!stage || typeof stage !== 'object' || Array.isArray(stage) || typeof (stage as { slug?: unknown }).slug !== 'string') {
      throw new Error('each stage must declare a string slug');
    }
    return stage as StageInput;
  });
}

function parseOptionalJsonObject(domain: Record<string, unknown>, path: string): Record<string, unknown> {
  const raw = stringDomainField(domain, path);
  if (!raw) return {};
  const parsed = JSON.parse(raw) as unknown;
  return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
    ? parsed as Record<string, unknown>
    : {};
}

function stringDomainField(domain: Record<string, unknown>, path: string): string | undefined {
  if (Object.prototype.hasOwnProperty.call(domain, path)) {
    const value = domain[path];
    return typeof value === 'string' ? value : undefined;
  }

  let current: unknown = domain;
  for (const segment of path.split('.')) {
    if (!current || typeof current !== 'object' || Array.isArray(current)) {
      return undefined;
    }
    current = (current as Record<string, unknown>)[segment];
  }
  return typeof current === 'string' ? current : undefined;
}

function hasExternalDelegation(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false;
  const json = JSON.stringify(value).toLowerCase();
  return hasAny(json, EXTERNAL_TERMS);
}

function hasAny(value: string, terms: readonly string[]): boolean {
  return terms.some((term) => value.includes(term));
}

function words(value: string): string {
  return value.replace(/[_-]+/gu, ' ');
}
