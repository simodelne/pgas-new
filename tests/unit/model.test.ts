import { describe, expect, it } from 'vitest';
import {
  GOVERNED_STATE_KEYS,
  PGAS_NEW_ACTIONS,
  PGAS_NEW_MODES,
  createInitialState,
} from '../../src/pgas-new/model.js';

describe('pgas-new governed model', () => {
  it('declares the approved governed state dictionary keys', () => {
    expect(GOVERNED_STATE_KEYS).toEqual([
      'session',
      'intake',
      'notebook',
      'research',
      'repo',
      'program',
      'domain_synthesis',
      'artifact_plan',
      'artifacts',
      'graduation',
      'curator_requests',
    ]);
  });

  it('declares the approved pgas-new modes in order', () => {
    expect(PGAS_NEW_MODES).toEqual([
      'intake_intelligence',
      'repo_targeting',
      'architecture_design',
      'scaffold_plan',
      'domain_synthesis',
      'branch_write',
      'static_verify',
      'smoke_verify',
      'live_verify',
      'rebase_verify',
      'pr_graduation',
      'curator_request',
    ]);
  });

  it('creates a conservative initial state for TypeScript/Node programs', () => {
    const state = createInitialState();

    expect(state.session.current_mode).toBe('intake_intelligence');
    expect(state.session.active_session_id).toBeUndefined();
    expect(state.session.active_session_running).toBe(false);
    expect(state.intake.research_allowed).toBe(false);
    expect(state.program.runtime).toBe('typescript-node');
    expect(state.program.architecture_ready).toBe(false);
    expect(state.program.domain_synthesis_complete).toBe(false);
    expect(state.domain_synthesis.audit).toEqual({});
    expect(state.repo.target_kind).toBe('unknown');
    expect(state.repo.blocked).toBe(false);
    expect(state.repo.write_authorized).toBe(false);
    expect(state.repo.wiring_manifest.status).toBe('unknown');
    expect(state.artifact_plan.status).toBe('none');
    expect(state.graduation.static_verification).toBe('pending');
    expect(state.graduation.smoke_verification).toBe('pending');
    expect(state.graduation.live_verification).toBe('pending');
    expect(state.graduation.rebase_status).toBe('pending');
    expect(state.graduation.rebase_verification).toBe('pending');
    expect(state.graduation.ready_for_live).toBe(false);
    expect(state.notebook.entries).toEqual([]);
  });

  it('includes semantic actions instead of exposing arbitrary bash', () => {
    expect(PGAS_NEW_ACTIONS).toContain('npm_install');
    expect(PGAS_NEW_ACTIONS).toContain('confirm_research_scope');
    expect(PGAS_NEW_ACTIONS).toContain('record_user_requested_research');
    expect(PGAS_NEW_ACTIONS).toContain('authorize_standalone_target');
    expect(PGAS_NEW_ACTIONS).toContain('authorize_existing_repo_target');
    expect(PGAS_NEW_ACTIONS).toContain('git_rebase_latest');
    expect(PGAS_NEW_ACTIONS).toContain('synthesize_domain_logic');
    expect(PGAS_NEW_ACTIONS).toContain('run_smoke_verification');
    expect(PGAS_NEW_ACTIONS).toContain('confirm_live_provider_intent');
    expect(PGAS_NEW_ACTIONS).toContain('run_rebase_static_verification');
    expect(PGAS_NEW_ACTIONS).toContain('open_pull_request');
    expect(PGAS_NEW_ACTIONS).toContain('session_new');
    expect(PGAS_NEW_ACTIONS).toContain('session_abort_current');
    expect(PGAS_NEW_ACTIONS).toContain('session_status');
    expect(PGAS_NEW_ACTIONS).toContain('session_history');
    expect(PGAS_NEW_ACTIONS).toContain('session_resume');
    expect(PGAS_NEW_ACTIONS).toContain('session_help');
    expect(PGAS_NEW_ACTIONS).not.toContain('run_arbitrary_command');
  });
});
