export interface SynthesisContext {
  program_slug: string;
  program_name: string;
  purpose: string;
  entry_channel: string;
  stages: Array<{
    slug: string;
    is_bootstrap?: boolean;
    is_terminal?: boolean;
    domain_spec?: {
      reads: string[];
      produces: Record<string, unknown>;
      rules: string[];
      invariants: string[];
    };
  }>;
  transitions: Array<{
    from: string;
    to: string;
    trigger?: string;
    guard_field?: string;
  }>;
  delegation: Record<string, unknown>;
  completion: {
    final_stage: string;
    guard_field: string;
    collection_lifecycle?: {
      version: number;
      name: string;
      item_label: string;
      storage: {
        items_path: string;
        event_path: string;
        violation_path: string;
        representation?: 'json_string' | 'indexed_array';
      };
      item: {
        id_field: string;
        status_field: string;
        schema: Record<string, unknown>;
      };
      statuses: Array<{
        name: string;
        initial?: boolean;
        terminal?: boolean;
      }>;
      transitions: Array<{
        from: string;
        to: string;
        stage: string;
        action: string;
        managed_by: 'llm' | 'reaction';
        trigger?: string;
        guard_field?: string;
      }>;
      aggregate: {
        guard_field: string;
        terminal_statuses: string[];
        require_non_empty: boolean;
      };
    };
  };
}

export interface SynthesizedArtifact {
  spec_yaml: string;
  mode_names: string[];
  sha256: string;
  created_at: string;
  contracts_ts: string;
  handlers_ts: string;
  handlers_index_ts: string;
  tools_ts: string;
  smoke_test_ts: string;
  stage_classification: unknown[];
  body_stage_slugs: string[];
  synthesis_context?: SynthesisContext;
  stage_sources?: Record<string, string>;
  domain_synthesis_audit?: Array<Record<string, unknown>>;
}

const artifactsBySessionId = new Map<string, SynthesizedArtifact>();

export function putSynthesizedArtifact(sessionId: string, artifact: SynthesizedArtifact): void {
  artifactsBySessionId.set(sessionId, artifact);
}

export function getSynthesizedArtifact(sessionId: string): SynthesizedArtifact | undefined {
  return artifactsBySessionId.get(sessionId);
}

export function clearSynthesizedArtifact(sessionId: string): void {
  artifactsBySessionId.delete(sessionId);
}

export function requireSynthesizedArtifact(sessionId: string): SynthesizedArtifact {
  const artifact = getSynthesizedArtifact(sessionId);
  if (!artifact) {
    throw new Error(`synthesized spec not in transit for session ${sessionId}; re-run synthesize_program_spec`);
  }
  return artifact;
}
