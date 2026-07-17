export interface DelegationChildSynthesizeDescriptor {
  kind: 'research_agent' | 'worker';
  purpose: string;
  result_fields: Record<string, string>;
  research_backend?: 'host_connector' | 'self_contained';
  slug?: string;
}

export interface CapabilityGap {
  capability: string;
  stage: string;
  connector_slug: string;
  message: string;
}

export interface DelegationChildDescriptor {
  id: string;
  stage: string;
  target_spec?: string;
  synthesize_child?: DelegationChildSynthesizeDescriptor;
  payload_map: Record<string, string>;
  result_path: string;
  max_delegated_rounds: number;
  round_timeout_ms?: number;
  optional: true;
}

export interface DelegationDescriptor extends Record<string, unknown> {
  children?: DelegationChildDescriptor[];
}

export interface DocumentsDescriptor {
  version?: number;
  stage: string;
  upload_types: string[];
  extraction: 'self_contained' | 'host_connector';
  result_path: string;
  required: boolean;
  fidelity_floor?: Record<string, unknown>;
  connector_slug?: string;
}

export interface ExportSurfaces {
  docx?: boolean;
  html?: boolean;
  diff?: boolean;
}

export interface DocumentExtractionSurfaces {
  docx?: boolean;
}

export interface ExportStageDescriptor {
  stage: string;
  kind: 'export_docx' | 'export_html';
  title: string;
  artifactType: 'docx_export' | 'html_export';
  payloadRef: string;
}

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
  delegation: DelegationDescriptor;
  documents?: DocumentsDescriptor;
  export_descriptors?: ExportStageDescriptor[];
  export_surfaces?: ExportSurfaces;
  document_extraction_surfaces?: DocumentExtractionSurfaces;
  interaction?: {
    confirmation_loops: Array<{
      collection: string;
      proposed_status: string;
      seed: {
        source_stage: string;
        id_prefix?: string;
      };
      item_id_field?: string;
      item_title_field?: string;
      decisions: Record<string, {
        to: string;
        requires_instruction?: boolean;
        instruction_path?: string;
        re_propose?: boolean;
      }>;
      one_proposed_at_a_time: true;
      aggregate: {
        guard_field: string;
        terminal_statuses: string[];
      };
      stage: string;
      summary_path?: string;
      violation_path?: string;
      pending_action_path?: string;
    }>;
  };
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
  registration_ts?: string;
  created_at: string;
  contracts_ts: string;
  handlers_ts: string;
  handlers_index_ts: string;
  tools_ts: string;
  smoke_test_ts: string;
  capability_gaps?: CapabilityGap[];
  export_surfaces?: ExportSurfaces;
  document_extraction_surfaces?: DocumentExtractionSurfaces;
  export_descriptors?: ExportStageDescriptor[];
  child_artifacts?: Array<Omit<SynthesizedArtifact, 'created_at' | 'child_artifacts'> & {
    slug: string;
    name: string;
  }>;
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
