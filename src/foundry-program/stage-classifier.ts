export type StageArchetype = 'pure-compute' | 'llm-reasoning' | 'external-adapter';

export interface ClassifiedStage {
  slug: string;
  archetype: StageArchetype;
  rationale: string;
  adapter_kind?: 'in_memory_mock' | 'repo_integration';
  integration_name?: string;
  integration_import?: string;
  integration_method?: string;
  integration_gap?: boolean;
  audit_note?: string;
}

interface StageInput {
  slug: string;
  is_bootstrap?: boolean;
  is_terminal?: boolean;
  domain_spec?: unknown;
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
  'assess',
  'author',
  'classify',
  'critique',
  'decide',
  'decision',
  'draft',
  'evaluate',
  'judge',
  'judgment',
  'negotiate',
  'narrative',
  'reason',
  'recommend',
  'revise',
  'review',
  'summarize',
  'summary',
] as const;

const COMPUTE_TERMS = [
  'aggregate',
  'aggregat',
  'assemble',
  'calculate',
  'compute',
  'comput',
  'estimate',
  'fee',
  'format',
  'model',
  'parse',
  'render',
  'score',
  'scoring',
  'tally',
  'validat',
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
  const stageDelegation = stageDelegationForSlug(delegation, slug);
  const explicitArchetype = explicitDelegationArchetype(stageDelegation);
  const stageScopedText = [
    slug,
    words(slug),
    stringifyForHeuristic(stage.domain_spec),
  ].join(' ').toLowerCase();
  const externalStageText = [
    stageScopedText,
    stringifyForHeuristic(stageDelegation),
  ].join(' ').toLowerCase();
  const purposeText = purpose.toLowerCase();
  const formulaicStage = hasAny(stageScopedText, COMPUTE_TERMS);

  if (explicitArchetype === 'external-adapter' || (!explicitArchetype && (hasAny(externalStageText, EXTERNAL_TERMS) || hasExternalDelegation(stageDelegation)))) {
    const explicitGap = explicitDelegationIntegrationGap(stageDelegation);
    return {
      slug,
      archetype: 'external-adapter',
      adapter_kind: 'in_memory_mock',
      ...(explicitGap ? {
        integration_gap: true,
        audit_note: explicitGap,
      } : {}),
      rationale: explicitArchetype === 'external-adapter'
        ? `external adapter: ${slug} was explicitly marked as an external adapter stage in Q5 delegation.${explicitGap ? ' Host connector implementation is required outside foundry code.' : ''}`
        : `external adapter: ${slug} references an integration/service boundary, so synthesis emits an in-memory mock.${explicitGap ? ' Host connector implementation is required outside foundry code.' : ''}`,
    };
  }

  if (explicitArchetype === 'llm-reasoning') {
    return {
      slug,
      archetype: 'llm-reasoning',
      rationale: `llm reasoning: ${slug} was explicitly marked as an LLM reasoning stage in Q5 delegation.`,
    };
  }

  if (explicitArchetype === 'pure-compute') {
    return {
      slug,
      archetype: 'pure-compute',
      rationale: `pure compute: ${slug} was explicitly marked as a deterministic stage in Q5 delegation.`,
    };
  }

  if (!formulaicStage && heuristicLeansReasoning(stage, stageScopedText, purposeText)) {
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

function explicitDelegationArchetype(value: unknown): StageArchetype | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const explicit = [record.kind, record.archetype, record.type]
    .find((candidate): candidate is string => typeof candidate === 'string')
    ?.toLowerCase();
  if (!explicit) {
    return record.reasoning_per_turn === true ? 'llm-reasoning' : undefined;
  }
  if (['llm-reasoning', 'llm_reasoning', 'reasoning'].includes(explicit)) return 'llm-reasoning';
  if (['pure-compute', 'pure_compute', 'compute', 'deterministic'].includes(explicit)) return 'pure-compute';
  if (['external-adapter', 'external_adapter', 'adapter', 'integration'].includes(explicit)) return 'external-adapter';
  if (record.reasoning_per_turn === true) return 'llm-reasoning';
  return undefined;
}

function explicitDelegationIntegrationGap(value: unknown): string | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (record.integration_gap === true || record.host_required === true || record.research_backend === 'host_connector') {
    const connector = typeof record.connector_slug === 'string' && record.connector_slug.trim().length > 0
      ? record.connector_slug.trim()
      : 'research';
    return `research backend is host-required — implement the ${connector} connector`;
  }
  return undefined;
}

function stageDelegationForSlug(delegation: Record<string, unknown>, slug: string): unknown {
  return valueAtStageKey(recordField(delegation, 'stages'), slug)
    ?? valueAtStageKey(recordField(recordField(delegation, 'execution_model'), 'stages'), slug)
    ?? valueAtStageKey(delegation, slug);
}

function recordField(value: unknown, key: string): Record<string, unknown> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const child = (value as Record<string, unknown>)[key];
  return child && typeof child === 'object' && !Array.isArray(child)
    ? child as Record<string, unknown>
    : undefined;
}

function valueAtStageKey(value: Record<string, unknown> | undefined, slug: string): unknown {
  if (!value || !Object.prototype.hasOwnProperty.call(value, slug)) return undefined;
  return value[slug];
}

function heuristicLeansReasoning(stage: StageInput, stageScopedText: string, purposeText: string): boolean {
  if (hasAny(stageScopedText, LLM_REASONING_TERMS)) return true;
  if (stage.is_bootstrap || stage.is_terminal) return false;
  return hasAny(purposeText, LLM_REASONING_TERMS);
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

function stringifyForHeuristic(value: unknown): string {
  if (value === undefined) return '';
  const json = JSON.stringify(value);
  return typeof json === 'string' ? json : String(value);
}

function hasAny(value: string, terms: readonly string[]): boolean {
  return terms.some((term) => value.includes(term));
}

function words(value: string): string {
  return value.replace(/[_-]+/gu, ' ');
}
