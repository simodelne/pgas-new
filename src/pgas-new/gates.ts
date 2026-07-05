import {
  FIXED_WIRING_MANIFEST_PATH,
  PGAS_NEW_ACTIONS,
  type PgasNewAction,
  type PgasNewMode,
  type PgasNewState,
} from './model.js';

export interface GateResult {
  allowed: boolean;
  reason?: string;
}

type ActionSet = Record<PgasNewMode, readonly PgasNewAction[]>;

const SESSION_CONTROL_ACTIONS = [
  'session_new',
  'session_abort_current',
  'session_status',
  'session_history',
  'session_resume',
  'session_help',
] as const satisfies readonly PgasNewAction[];

const BASE_ACTIONS_BY_MODE: ActionSet = {
  intake_intelligence: [
    ...SESSION_CONTROL_ACTIONS,
    'record_user_note',
    'pin_notebook_note',
    'confirm_research_scope',
    'record_user_requested_research',
    'web_research',
  ],
  repo_targeting: [
    ...SESSION_CONTROL_ACTIONS,
    'select_repo_target',
    'authorize_standalone_target',
    'load_wiring_manifest',
    'authorize_existing_repo_target',
    'create_curator_request',
  ],
  architecture_design: [...SESSION_CONTROL_ACTIONS, 'design_architecture', 'web_research', 'record_user_note'],
  scaffold_plan: [...SESSION_CONTROL_ACTIONS, 'plan_artifacts', 'await_artifact_plan_approval', 'approve_artifact_plan', 'create_curator_request'],
  domain_synthesis: [...SESSION_CONTROL_ACTIONS, 'synthesize_domain_logic', 'record_user_note'],
  branch_write: [...SESSION_CONTROL_ACTIONS, 'write_scaffold_artifacts', 'git_status'],
  static_verify: [
    ...SESSION_CONTROL_ACTIONS,
    'npm_install',
    'npm_typecheck',
    'npm_test',
    'run_static_verification',
    'run_parallel_static_checks',
  ],
  smoke_verify: [...SESSION_CONTROL_ACTIONS, 'run_smoke_verification', 'confirm_live_provider_intent'],
  live_verify: [
    ...SESSION_CONTROL_ACTIONS,
    'run_api_blackbox_verification',
    'run_live_provider_verification',
    'run_generated_live_drive_verification',
  ],
  rebase_verify: [...SESSION_CONTROL_ACTIONS, 'git_status', 'git_rebase_latest', 'run_rebase_static_verification'],
  pr_graduation: [...SESSION_CONTROL_ACTIONS, 'open_pull_request'],
  curator_request: [...SESSION_CONTROL_ACTIONS, 'create_curator_request', 'record_user_note'],
};

export function legalActionsForMode(state: PgasNewState, mode: PgasNewMode): PgasNewAction[] {
  if (state.session.current_mode !== mode) {
    return [];
  }

  const actions = new Set(baseActionsForMode(mode));

  if (mode === 'repo_targeting' && shouldRouteToCurator(state)) {
    actions.add('create_curator_request');
  }

  return PGAS_NEW_ACTIONS.filter((action) => actions.has(action) && isActionStateAllowed(state, mode, action).allowed);
}

export function assertActionAllowed(
  state: PgasNewState,
  mode: PgasNewMode,
  action: PgasNewAction,
): void {
  if (state.session.current_mode !== mode) {
    throw new Error('mode_must_match_state_current_mode');
  }

  const actionGate = canUseAction(state, mode, action);
  if (!actionGate.allowed) {
    throw new Error(actionGate.reason);
  }
}

export function canTransition(
  state: PgasNewState,
  from: PgasNewMode,
  to: PgasNewMode,
): GateResult {
  if (state.session.current_mode !== from) {
    return deny('from_mode_must_match_state_current_mode');
  }

  const transition = `${from}->${to}`;

  switch (transition) {
    case 'intake_intelligence->repo_targeting':
      return allow();
    case 'architecture_design->scaffold_plan':
      return state.program.architecture_ready ? allow() : deny('scaffold_plan_requires_architecture_ready');
    case 'repo_targeting->architecture_design':
      return canEnterArchitectureDesign(state);
    case 'repo_targeting->curator_request':
    case 'scaffold_plan->curator_request':
      return shouldRouteToCurator(state) ? allow() : deny('curator_request_requires_repo_blocker');
    case 'scaffold_plan->domain_synthesis':
      return canEnterDomainSynthesis(state);
    case 'domain_synthesis->branch_write':
      return state.program.domain_synthesis_complete
        ? canEnterBranchWrite(state)
        : deny('branch_write_requires_domain_synthesis_complete');
    case 'branch_write->static_verify':
      return state.artifacts.written ? allow() : deny('static_verify_requires_written_artifacts');
    case 'static_verify->smoke_verify':
      return state.graduation.static_verification === 'passed'
        ? allow()
        : deny('smoke_verify_requires_static_passed');
    case 'smoke_verify->live_verify':
      return canEnterLiveVerify(state);
    case 'live_verify->rebase_verify':
      // Hard-required generated live-drive gate: a fail OR skip/absent (pending)
      // live-drive result BLOCKS graduation — only an explicit 'passed' crosses.
      if (state.graduation.live_verification !== 'passed') {
        return deny('rebase_verify_requires_live_verification_passed');
      }
      return state.graduation.generated_live_drive === 'passed'
        ? allow()
        : deny('rebase_verify_requires_generated_live_drive_passed');
    case 'rebase_verify->pr_graduation':
      return canEnterPrGraduation(state);
    case 'curator_request->repo_targeting':
      return state.repo.curator_request_lodged
        ? allow()
        : deny('repo_targeting_return_requires_lodged_curator_request');
    default:
      return deny('transition_not_declared');
  }
}

function canUseAction(state: PgasNewState, mode: PgasNewMode, action: PgasNewAction): GateResult {
  if (!baseActionsForMode(mode).includes(action)) {
    return deny('action_not_legal_in_mode');
  }

  return isActionStateAllowed(state, mode, action);
}

function isActionStateAllowed(state: PgasNewState, mode: PgasNewMode, action: PgasNewAction): GateResult {
  if (action === 'web_research' && !isResearchAllowed(state)) {
    return deny('research_requires_user_confirmation');
  }

  if (action === 'session_abort_current' && (!state.session.active_session_id || !state.session.active_session_running)) {
    return deny('session_abort_requires_active_running_session');
  }

  if (action === 'write_scaffold_artifacts') {
    return canEnterBranchWrite(state);
  }

  if (action === 'synthesize_domain_logic') {
    return canEnterDomainSynthesis(state);
  }

  if (action === 'authorize_standalone_target' && state.repo.target_kind !== 'standalone_repo') {
    return deny('standalone_authorization_requires_standalone_target');
  }

  if (action === 'load_wiring_manifest' && state.repo.target_kind !== 'existing_repo') {
    return deny('load_wiring_manifest_requires_existing_repo_target');
  }

  if (action === 'authorize_existing_repo_target') {
    return canAuthorizeExistingRepo(state);
  }

  if (
    mode === 'live_verify' &&
    (action === 'run_api_blackbox_verification' ||
      action === 'run_live_provider_verification' ||
      action === 'run_generated_live_drive_verification')
  ) {
    const gate = canEnterLiveVerify(state);
    if (!gate.allowed) {
      return gate;
    }
    // Mirrors the spec precondition: recording live verification is blocked
    // until the generated live drive has explicitly passed (hard gate — a
    // failed/skipped/absent drive keeps graduation.live_verification pending).
    if (action === 'run_live_provider_verification' && state.graduation.generated_live_drive !== 'passed') {
      return deny('live_provider_verification_requires_generated_live_drive_passed');
    }
    return gate;
  }

  if (action === 'run_smoke_verification' && state.graduation.static_verification !== 'passed') {
    return deny('smoke_verify_requires_static_passed');
  }

  if (action === 'confirm_live_provider_intent' && state.graduation.smoke_verification !== 'passed') {
    return deny('live_provider_intent_requires_smoke_passed');
  }

  if (action === 'run_rebase_static_verification' && state.graduation.rebase_status !== 'passed') {
    return deny('post_rebase_static_verification_requires_successful_rebase');
  }

  if (action === 'open_pull_request') {
    return canEnterPrGraduation(state);
  }

  if (action === 'create_curator_request' && mode !== 'curator_request' && !shouldRouteToCurator(state)) {
    return deny('curator_request_requires_repo_blocker');
  }

  return allow();
}

function canEnterArchitectureDesign(state: PgasNewState): GateResult {
  if (state.repo.target_kind === 'unknown') {
    return deny('architecture_design_requires_repo_target');
  }

  if (!state.repo.write_authorized) {
    return deny('architecture_design_requires_write_authorization');
  }

  if (state.repo.target_kind === 'existing_repo') {
    return canAuthorizeExistingRepo(state);
  }

  return allow();
}

function canAuthorizeExistingRepo(state: PgasNewState): GateResult {
  if (state.repo.target_kind !== 'existing_repo') {
    return deny('existing_repo_authorization_requires_existing_repo_target');
  }

  if (state.repo.wiring_manifest.status !== 'valid') {
    return deny('existing_repo_requires_valid_wiring_manifest');
  }

  if (state.repo.wiring_manifest.path !== FIXED_WIRING_MANIFEST_PATH) {
    return deny('existing_repo_requires_fixed_path_wiring_manifest');
  }

  return allow();
}

function canEnterBranchWrite(state: PgasNewState): GateResult {
  if (!state.program.domain_synthesis_complete) {
    return deny('branch_write_requires_domain_synthesis_complete');
  }

  return canEnterDomainSynthesisBase(state, 'branch_write');
}

function canEnterDomainSynthesis(state: PgasNewState): GateResult {
  if (state.program.domain_synthesis_complete) {
    return deny('domain_synthesis_already_complete');
  }

  return canEnterDomainSynthesisBase(state, 'domain_synthesis');
}

function canEnterDomainSynthesisBase(state: PgasNewState, target: 'domain_synthesis' | 'branch_write'): GateResult {
  if (!state.repo.write_authorized) {
    return deny(`${target}_requires_write_authorization`);
  }

  if (state.repo.target_kind === 'existing_repo') {
    const gate = canAuthorizeExistingRepo(state);
    if (!gate.allowed) {
      return gate;
    }
  }

  if (state.artifact_plan.status !== 'approved' || !state.artifact_plan.approved) {
    return deny(`${target}_requires_approved_artifact_plan`);
  }

  if (!state.artifact_plan.write_authorized) {
    return deny(`${target}_requires_artifact_write_authorization`);
  }

  return allow();
}

function canEnterLiveVerify(state: PgasNewState): GateResult {
  if (state.graduation.static_verification !== 'passed') {
    return deny('live_verify_requires_static_passed');
  }

  if (state.graduation.smoke_verification !== 'passed') {
    return deny('live_verify_requires_smoke_passed');
  }

  if (!state.graduation.live_provider_intent) {
    return deny('live_verify_requires_live_provider_intent');
  }

  if (!state.graduation.ready_for_live) {
    return deny('live_verify_requires_ready_for_live');
  }

  return allow();
}

function canEnterPrGraduation(state: PgasNewState): GateResult {
  return state.graduation.rebase_verification === 'passed'
    ? allow()
    : deny('pr_requires_post_rebase_verification');
}

function shouldRouteToCurator(state: PgasNewState): boolean {
  return (
    state.repo.target_kind === 'existing_repo' &&
    (state.repo.blocked ||
      state.repo.wiring_manifest.status === 'absent' ||
      state.repo.wiring_manifest.status === 'invalid' ||
      state.repo.required_facilities_missing.length > 0)
  );
}

function isResearchAllowed(state: PgasNewState): boolean {
  return state.intake.research_allowed || state.intake.research_confirmed || state.intake.user_requested_research;
}

function baseActionsForMode(mode: PgasNewMode): readonly PgasNewAction[] {
  return BASE_ACTIONS_BY_MODE[mode];
}

function allow(): GateResult {
  return { allowed: true };
}

function deny(reason: string): GateResult {
  return { allowed: false, reason };
}
