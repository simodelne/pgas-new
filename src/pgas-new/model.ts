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
  'web_research',
  'select_repo_target',
  'load_wiring_manifest',
  'create_curator_request',
  'design_architecture',
  'plan_artifacts',
  'approve_artifact_plan',
  'write_scaffold_artifacts',
  'npm_install',
  'npm_typecheck',
  'npm_test',
  'run_static_verification',
  'run_api_blackbox_verification',
  'run_live_provider_verification',
  'git_status',
  'git_rebase_latest',
  'open_pull_request',
] as const;

export type PgasNewAction = (typeof PGAS_NEW_ACTIONS)[number];

export type RepoTargetKind = 'unknown' | 'standalone_repo' | 'existing_repo';
export type WiringManifestStatus = 'unknown' | 'absent' | 'invalid' | 'valid';
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
    research_confirmed: boolean;
    user_requested_research: boolean;
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
    wiring_manifest: {
      status: WiringManifestStatus;
      path?: typeof FIXED_WIRING_MANIFEST_PATH;
      errors?: string[];
    };
    required_facilities_missing: string[];
  };
  program: {
    runtime: 'typescript-node';
    slug?: string;
    name?: string;
  };
  artifact_plan: {
    status: PlanningStatus;
    artifacts: unknown[];
  };
  artifacts: {
    written: boolean;
    generated_paths: string[];
  };
  graduation: {
    static_verification: VerificationStatus;
    live_verification: VerificationStatus;
    rebase_verification: VerificationStatus;
    live_provider_intent: boolean;
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
      research_confirmed: false,
      user_requested_research: false,
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
      wiring_manifest: {
        status: 'unknown',
      },
      required_facilities_missing: [],
    },
    program: {
      runtime: 'typescript-node',
    },
    artifact_plan: {
      status: 'none',
      artifacts: [],
    },
    artifacts: {
      written: false,
      generated_paths: [],
    },
    graduation: {
      static_verification: 'pending',
      live_verification: 'pending',
      rebase_verification: 'pending',
      live_provider_intent: false,
    },
    curator_requests: {
      requests: [],
    },
  };
}
