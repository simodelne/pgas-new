export const GOVERNED_STATE_KEYS = [
  'session',
  'intake',
  'notebook',
  'research',
  'repo',
  'program',
  'artifact_plan',
  'artifacts',
  'graduation',
  'curator_requests',
] as const;

export type GovernedStateKey = (typeof GOVERNED_STATE_KEYS)[number];

export const PGAS_NEW_MODES = [
  'intake_intelligence',
  'repo_targeting',
  'architecture_design',
  'scaffold_plan',
  'branch_write',
  'static_verify',
  'live_verify',
  'rebase_verify',
  'pr_graduation',
  'curator_request',
] as const;

export type PgasNewMode = (typeof PGAS_NEW_MODES)[number];

export const FIXED_WIRING_MANIFEST_PATH = '.pgas/wiring.yml';

export const PGAS_NEW_ACTIONS = [
  'session_new',
  'session_abort_current',
  'session_status',
  'session_history',
  'session_resume',
  'session_help',
  'record_user_note',
  'pin_notebook_note',
  'confirm_research_scope',
  'record_user_requested_research',
  'web_research',
  'select_repo_target',
  'authorize_standalone_target',
  'authorize_existing_repo_target',
  'load_wiring_manifest',
  'create_curator_request',
  'synthesize_program_spec',
  'design_architecture',
  'plan_artifacts',
  'approve_artifact_plan',
  'write_scaffold_artifacts',
  'npm_install',
  'npm_typecheck',
  'npm_test',
  'run_static_verification',
  'run_parallel_static_checks',
  'confirm_live_provider_intent',
  'run_api_blackbox_verification',
  'run_live_provider_verification',
  'git_status',
  'git_rebase_latest',
  'run_rebase_static_verification',
  'open_pull_request',
] as const;

export type PgasNewAction = (typeof PGAS_NEW_ACTIONS)[number];

export type RepoTargetKind = 'unknown' | 'standalone_repo' | 'existing_repo';
export type WiringManifestStatus = 'unknown' | 'absent' | 'invalid' | 'valid' | 'not_required';
export type PlanningStatus = 'none' | 'draft' | 'approved';
export type VerificationStatus = 'pending' | 'passed' | 'failed' | 'skipped';

export interface PgasNewState {
  session: {
    current_mode: PgasNewMode;
    active_session_id?: string;
    active_session_running: boolean;
  };
  intake: {
    mandate?: string;
    last_question_asked: number;
    last_question_text: string;
    research_confirmed: boolean;
    user_requested_research: boolean;
    research_allowed: boolean;
  };
  notebook: {
    entries: string[];
    pins: string[];
  };
  research: {
    queries: string[];
    completed: boolean;
  };
  repo: {
    target_kind: RepoTargetKind;
    blocked: boolean;
    write_authorized: boolean;
    wiring_manifest: {
      status: WiringManifestStatus;
      path?: typeof FIXED_WIRING_MANIFEST_PATH;
      errors?: string[];
    };
    required_facilities_missing: string[];
    curator_request_lodged?: boolean;
  };
  program: {
    runtime: 'typescript-node';
    slug?: string;
    name?: string;
    architecture_ready: boolean;
  };
  artifact_plan: {
    status: PlanningStatus;
    approved: boolean;
    write_authorized: boolean;
    artifacts: unknown[];
  };
  artifacts: {
    written: boolean;
    generated_paths: string[];
  };
  graduation: {
    static_verification: VerificationStatus;
    live_verification: VerificationStatus;
    rebase_status: VerificationStatus;
    rebase_verification: VerificationStatus;
    live_provider_intent: boolean;
    ready_for_live: boolean;
    static_evidence_id?: string;
    live_evidence_id?: string;
    rebase_evidence_id?: string;
    rebase_static_evidence_id?: string;
  };
  curator_requests: {
    requests: string[];
  };
}

export function createInitialState(): PgasNewState {
  return {
    session: {
      current_mode: 'intake_intelligence',
      active_session_running: false,
    },
    intake: {
      last_question_asked: 0,
      last_question_text: '',
      research_confirmed: false,
      user_requested_research: false,
      research_allowed: false,
    },
    notebook: {
      entries: [],
      pins: [],
    },
    research: {
      queries: [],
      completed: false,
    },
    repo: {
      target_kind: 'unknown',
      blocked: false,
      write_authorized: false,
      wiring_manifest: {
        status: 'unknown',
      },
      required_facilities_missing: [],
    },
    program: {
      runtime: 'typescript-node',
      architecture_ready: false,
    },
    artifact_plan: {
      status: 'none',
      approved: false,
      write_authorized: false,
      artifacts: [],
    },
    artifacts: {
      written: false,
      generated_paths: [],
    },
    graduation: {
      static_verification: 'pending',
      live_verification: 'pending',
      rebase_status: 'pending',
      rebase_verification: 'pending',
      live_provider_intent: false,
      ready_for_live: false,
    },
    curator_requests: {
      requests: [],
    },
  };
}
