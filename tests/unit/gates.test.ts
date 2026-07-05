import { describe, expect, it } from 'vitest';
import { createInitialState, type PgasNewState } from '../../src/pgas-new/model.js';
import { assertActionAllowed, canTransition, legalActionsForMode } from '../../src/pgas-new/gates.js';

function withMode(state: PgasNewState, mode: PgasNewState['session']['current_mode']): PgasNewState {
  return {
    ...state,
    session: {
      ...state.session,
      current_mode: mode,
    },
  };
}

function existingRepoState(): PgasNewState {
  const initial = createInitialState();
  return {
    ...initial,
    repo: {
      ...initial.repo,
      target_kind: 'existing_repo',
      blocked: false,
      write_authorized: true,
      wiring_manifest: { status: 'valid', path: '.pgas/wiring.yml' },
    },
    program: {
      ...initial.program,
      slug: 'legal-rag',
      name: 'Legal RAG',
      architecture_ready: true,
      domain_synthesis_complete: false,
    },
    artifact_plan: {
      status: 'approved',
      approved: true,
      write_authorized: true,
      artifacts: [],
    },
  };
}

describe('pgas-new gates', () => {
  it('allows the happy-path transition ladder when prerequisites are met', () => {
    const state = withMode(existingRepoState(), 'intake_intelligence');

    expect(canTransition(state, 'intake_intelligence', 'repo_targeting')).toMatchObject({ allowed: true });
    expect(canTransition(withMode(state, 'repo_targeting'), 'repo_targeting', 'architecture_design')).toMatchObject({ allowed: true });
    expect(canTransition(withMode(state, 'architecture_design'), 'architecture_design', 'scaffold_plan')).toMatchObject({ allowed: true });
    expect(canTransition(withMode(state, 'scaffold_plan'), 'scaffold_plan', 'domain_synthesis')).toMatchObject({ allowed: true });
    const domainReady = {
      ...state,
      program: { ...state.program, domain_synthesis_complete: true },
    } satisfies PgasNewState;
    expect(canTransition(withMode(domainReady, 'domain_synthesis'), 'domain_synthesis', 'branch_write')).toMatchObject({ allowed: true });

    const written = {
      ...withMode(domainReady, 'branch_write'),
      artifacts: { written: true, generated_paths: ['programs/legal-rag/specs.yml'] },
    } satisfies PgasNewState;
    expect(canTransition(written, 'branch_write', 'static_verify')).toMatchObject({ allowed: true });

    const staticPassed = {
      ...written,
      graduation: {
        ...written.graduation,
        static_verification: 'passed',
        live_provider_intent: true,
        ready_for_live: true,
      },
    } satisfies PgasNewState;
    expect(canTransition(withMode(staticPassed, 'static_verify'), 'static_verify', 'smoke_verify')).toMatchObject({ allowed: true });

    const smokePassed = {
      ...staticPassed,
      graduation: {
        ...staticPassed.graduation,
        smoke_verification: 'passed',
        live_provider_intent: true,
        ready_for_live: true,
      },
    } satisfies PgasNewState;
    expect(canTransition(withMode(smokePassed, 'smoke_verify'), 'smoke_verify', 'live_verify')).toMatchObject({ allowed: true });

    const livePassed = {
      ...withMode(smokePassed, 'live_verify'),
      graduation: {
        ...smokePassed.graduation,
        live_verification: 'passed',
        generated_live_drive: 'passed',
      },
    } satisfies PgasNewState;
    expect(canTransition(livePassed, 'live_verify', 'rebase_verify')).toMatchObject({ allowed: true });

    const rebased = {
      ...withMode(livePassed, 'rebase_verify'),
      graduation: { ...livePassed.graduation, rebase_status: 'passed', rebase_verification: 'passed' },
    } satisfies PgasNewState;
    expect(canTransition(rebased, 'rebase_verify', 'pr_graduation')).toMatchObject({ allowed: true });
  });

  it('treats state.session.current_mode as authoritative for transitions and actions', () => {
    const state = createInitialState();

    expect(canTransition(state, 'scaffold_plan', 'branch_write')).toEqual({
      allowed: false,
      reason: 'from_mode_must_match_state_current_mode',
    });
    expect(legalActionsForMode(state, 'static_verify')).toEqual([]);
    expect(() => assertActionAllowed(state, 'static_verify', 'npm_test')).toThrow(
      /mode_must_match_state_current_mode/,
    );
  });

  it('blocks existing-repo writes without a valid fixed-path wiring manifest', () => {
    const state = {
      ...withMode(existingRepoState(), 'scaffold_plan'),
      repo: {
        target_kind: 'existing_repo',
        blocked: false,
        write_authorized: true,
        wiring_manifest: { status: 'absent' },
        required_facilities_missing: [],
      },
    } satisfies PgasNewState;

    expect(canTransition(state, 'scaffold_plan', 'domain_synthesis')).toEqual({
      allowed: false,
      reason: 'existing_repo_requires_valid_wiring_manifest',
    });
    expect(legalActionsForMode(withMode(state, 'repo_targeting'), 'repo_targeting')).toContain('create_curator_request');
  });

  it('blocks existing-repo writes when a valid manifest is not at the fixed path', () => {
    const state = {
      ...withMode(existingRepoState(), 'scaffold_plan'),
      repo: {
        target_kind: 'existing_repo',
        blocked: false,
        write_authorized: true,
        wiring_manifest: { status: 'valid' },
        required_facilities_missing: [],
      },
    } satisfies PgasNewState;

    expect(canTransition(state, 'scaffold_plan', 'domain_synthesis')).toEqual({
      allowed: false,
      reason: 'existing_repo_requires_fixed_path_wiring_manifest',
    });
  });

  it('routes absent or invalid repo facilities to curator_request', () => {
    const absent = {
      ...createInitialState(),
      session: { ...createInitialState().session, current_mode: 'repo_targeting' },
      repo: {
        target_kind: 'existing_repo',
        blocked: false,
        write_authorized: false,
        wiring_manifest: { status: 'absent' },
        required_facilities_missing: [],
      },
    } satisfies PgasNewState;
    const invalid = {
      ...absent,
      repo: {
        target_kind: 'existing_repo',
        blocked: false,
        write_authorized: false,
        wiring_manifest: { status: 'invalid', errors: ['pgas.allowed_imports contains a private import'] },
        required_facilities_missing: [],
      },
    } satisfies PgasNewState;
    const missingFacility = {
      ...absent,
      repo: {
        target_kind: 'existing_repo',
        blocked: false,
        write_authorized: false,
        wiring_manifest: { status: 'valid', path: '.pgas/wiring.yml' },
        required_facilities_missing: ['registration_marker'],
      },
    } satisfies PgasNewState;

    expect(canTransition(absent, 'repo_targeting', 'curator_request')).toMatchObject({ allowed: true });
    expect(canTransition(invalid, 'repo_targeting', 'curator_request')).toMatchObject({ allowed: true });
    expect(canTransition(missingFacility, 'repo_targeting', 'curator_request')).toMatchObject({ allowed: true });
  });

  it('requires explicit target authorization before architecture design', () => {
    const existing = withMode({ ...existingRepoState(), repo: { ...existingRepoState().repo, write_authorized: false } }, 'repo_targeting');

    expect(canTransition(existing, 'repo_targeting', 'architecture_design')).toEqual({
      allowed: false,
      reason: 'architecture_design_requires_write_authorization',
    });
    expect(legalActionsForMode(existing, 'repo_targeting')).toContain('authorize_existing_repo_target');

    const standalone = {
      ...createInitialState(),
      session: { ...createInitialState().session, current_mode: 'repo_targeting' },
      repo: {
        ...createInitialState().repo,
        target_kind: 'standalone_repo',
        write_authorized: false,
        wiring_manifest: { status: 'not_required' },
      },
    } satisfies PgasNewState;
    expect(legalActionsForMode(standalone, 'repo_targeting')).toContain('authorize_standalone_target');
  });

  it('requires architecture readiness before scaffold planning', () => {
    const state = {
      ...withMode(existingRepoState(), 'architecture_design'),
      program: { ...existingRepoState().program, architecture_ready: false },
    } satisfies PgasNewState;

    expect(canTransition(state, 'architecture_design', 'scaffold_plan')).toEqual({
      allowed: false,
      reason: 'scaffold_plan_requires_architecture_ready',
    });

    expect(canTransition({ ...state, program: { ...state.program, architecture_ready: true } }, 'architecture_design', 'scaffold_plan')).toEqual({
      allowed: true,
    });
  });

  it('requires complete artifact approval before branch writes', () => {
    const draft = {
      ...withMode(existingRepoState(), 'scaffold_plan'),
      artifact_plan: { status: 'draft', approved: false, write_authorized: false, artifacts: [] },
    } satisfies PgasNewState;
    const approvedButNotWriteAuthorized = {
      ...draft,
      artifact_plan: { status: 'approved', approved: true, write_authorized: false, artifacts: [] },
    } satisfies PgasNewState;

    expect(canTransition(draft, 'scaffold_plan', 'domain_synthesis')).toEqual({
      allowed: false,
      reason: 'domain_synthesis_requires_approved_artifact_plan',
    });
    expect(canTransition(approvedButNotWriteAuthorized, 'scaffold_plan', 'domain_synthesis')).toEqual({
      allowed: false,
      reason: 'domain_synthesis_requires_artifact_write_authorization',
    });
    expect(canTransition({ ...draft, session: { ...draft.session, current_mode: 'domain_synthesis' } }, 'domain_synthesis', 'branch_write')).toEqual({
      allowed: false,
      reason: 'branch_write_requires_domain_synthesis_complete',
    });
  });

  it('requires successful rebase before post-rebase static verification action', () => {
    const state = withMode(existingRepoState(), 'rebase_verify');

    expect(legalActionsForMode(state, 'rebase_verify')).not.toContain('run_rebase_static_verification');
    expect(() => assertActionAllowed(state, 'rebase_verify', 'run_rebase_static_verification')).toThrow(
      /post_rebase_static_verification_requires_successful_rebase/,
    );

    const rebased = {
      ...state,
      graduation: { ...state.graduation, rebase_status: 'passed' },
    } satisfies PgasNewState;
    expect(legalActionsForMode(rebased, 'rebase_verify')).toContain('run_rebase_static_verification');
  });

  it('only allows curator request creation when a repo blocker exists or while in curator_request mode', () => {
    const state = withMode(existingRepoState(), 'repo_targeting');

    expect(legalActionsForMode(state, 'repo_targeting')).not.toContain('create_curator_request');
    expect(() => assertActionAllowed(state, 'repo_targeting', 'create_curator_request')).toThrow(
      /curator_request_requires_repo_blocker/,
    );
    expect(() => assertActionAllowed(withMode(state, 'curator_request'), 'curator_request', 'create_curator_request')).not.toThrow();
  });

  it('requires user confirmation before discretionary web research', () => {
    const state = createInitialState();

    expect(legalActionsForMode(state, 'intake_intelligence')).not.toContain('web_research');
    expect(() => assertActionAllowed(state, 'intake_intelligence', 'web_research')).toThrow(
      /research_requires_user_confirmation/,
    );

    const confirmed = {
      ...state,
      intake: { ...state.intake, research_confirmed: true },
    } satisfies PgasNewState;
    expect(legalActionsForMode(confirmed, 'intake_intelligence')).toContain('web_research');
    expect(() => assertActionAllowed(confirmed, 'intake_intelligence', 'web_research')).not.toThrow();

    const userRequested = {
      ...state,
      intake: { ...state.intake, user_requested_research: true },
    } satisfies PgasNewState;
    expect(() => assertActionAllowed(userRequested, 'intake_intelligence', 'web_research')).not.toThrow();
  });

  it('makes session lifecycle controls available in every mode with abort gated by active running session', () => {
    const state = createInitialState();

    expect(legalActionsForMode(state, 'intake_intelligence')).toEqual(
      expect.arrayContaining(['session_new', 'session_status', 'session_history', 'session_resume', 'session_help']),
    );
    expect(legalActionsForMode(withMode(state, 'static_verify'), 'static_verify')).toEqual(
      expect.arrayContaining(['session_new', 'session_status', 'session_history', 'session_resume', 'session_help']),
    );
    expect(() => assertActionAllowed(state, 'intake_intelligence', 'session_abort_current')).toThrow(
      /session_abort_requires_active_running_session/,
    );

    const running = {
      ...state,
      session: {
        ...state.session,
        active_session_id: 'session-123',
        active_session_running: true,
      },
    } satisfies PgasNewState;
    expect(legalActionsForMode(running, 'intake_intelligence')).toContain('session_abort_current');
    expect(() => assertActionAllowed(running, 'intake_intelligence', 'session_abort_current')).not.toThrow();
  });

  it('requires static success, smoke success, and live-provider intent before live verification', () => {
    const state = {
      ...withMode(existingRepoState(), 'static_verify'),
      artifacts: { written: true, generated_paths: ['programs/legal-rag/specs.yml'] },
    } satisfies PgasNewState;

    expect(canTransition(state, 'static_verify', 'smoke_verify')).toEqual({
      allowed: false,
      reason: 'smoke_verify_requires_static_passed',
    });

    const staticPassed = {
      ...state,
      graduation: { ...state.graduation, static_verification: 'passed', live_provider_intent: false },
    } satisfies PgasNewState;
    expect(canTransition(staticPassed, 'static_verify', 'smoke_verify')).toEqual({ allowed: true });
    expect(canTransition(withMode(staticPassed, 'smoke_verify'), 'smoke_verify', 'live_verify')).toEqual({
      allowed: false,
      reason: 'live_verify_requires_smoke_passed',
    });
    const smokePassed = {
      ...withMode(staticPassed, 'smoke_verify'),
      graduation: { ...staticPassed.graduation, smoke_verification: 'passed', live_provider_intent: false },
    } satisfies PgasNewState;
    expect(canTransition(smokePassed, 'smoke_verify', 'live_verify')).toEqual({
      allowed: false,
      reason: 'live_verify_requires_live_provider_intent',
    });
    const intentWithoutReady = {
      ...smokePassed,
      graduation: { ...smokePassed.graduation, live_provider_intent: true, ready_for_live: false },
    } satisfies PgasNewState;
    expect(canTransition(intentWithoutReady, 'smoke_verify', 'live_verify')).toEqual({
      allowed: false,
      reason: 'live_verify_requires_ready_for_live',
    });
    const ready = {
      ...smokePassed,
      graduation: { ...smokePassed.graduation, live_provider_intent: true, ready_for_live: true },
    } satisfies PgasNewState;
    expect(canTransition(ready, 'smoke_verify', 'live_verify')).toEqual({ allowed: true });
    const staticPassedInLiveMode = withMode(staticPassed, 'live_verify');
    expect(legalActionsForMode(staticPassedInLiveMode, 'live_verify')).not.toContain('run_api_blackbox_verification');
    expect(() => assertActionAllowed(staticPassedInLiveMode, 'live_verify', 'run_api_blackbox_verification')).toThrow(
      /live_verify_requires_smoke_passed/,
    );
  });

  it('hard-blocks live_verify -> rebase_verify unless the generated live drive explicitly passed', () => {
    const base = {
      ...withMode(existingRepoState(), 'live_verify'),
      artifacts: { written: true, generated_paths: ['programs/legal-rag/specs.yml'] },
    } satisfies PgasNewState;
    const withGraduation = (
      live_verification: PgasNewState['graduation']['live_verification'],
      generated_live_drive: PgasNewState['graduation']['generated_live_drive'],
    ): PgasNewState => ({
      ...base,
      graduation: {
        ...base.graduation,
        static_verification: 'passed',
        smoke_verification: 'passed',
        live_provider_intent: true,
        ready_for_live: true,
        live_verification,
        generated_live_drive,
      },
    });

    // Live provider rung still gates first.
    expect(canTransition(withGraduation('pending', 'passed'), 'live_verify', 'rebase_verify')).toEqual({
      allowed: false,
      reason: 'rebase_verify_requires_live_verification_passed',
    });

    // Hard requirement: absent (pending), skipped, and failed live-drive
    // evidence ALL deny — only an explicit 'passed' crosses.
    for (const blockedStatus of ['pending', 'skipped', 'failed'] as const) {
      expect(canTransition(withGraduation('passed', blockedStatus), 'live_verify', 'rebase_verify')).toEqual({
        allowed: false,
        reason: 'rebase_verify_requires_generated_live_drive_passed',
      });
    }

    expect(canTransition(withGraduation('passed', 'passed'), 'live_verify', 'rebase_verify')).toEqual({ allowed: true });

    // The action is legal in live_verify once the live rung prerequisites hold.
    expect(legalActionsForMode(withGraduation('pending', 'pending'), 'live_verify')).toContain(
      'run_generated_live_drive_verification',
    );

    // Mirrors the spec precondition: recording live verification is blocked
    // until the drive passed, so a skipped/failed drive can never be papered
    // over by running the live-provider rung alone.
    for (const blockedStatus of ['pending', 'skipped', 'failed'] as const) {
      expect(() =>
        assertActionAllowed(withGraduation('pending', blockedStatus), 'live_verify', 'run_live_provider_verification'),
      ).toThrow(/live_provider_verification_requires_generated_live_drive_passed/);
    }
    expect(() =>
      assertActionAllowed(withGraduation('pending', 'passed'), 'live_verify', 'run_live_provider_verification'),
    ).not.toThrow();
  });

  it('requires post-rebase verification before opening a pull request', () => {
    const state = withMode(existingRepoState(), 'rebase_verify');

    expect(canTransition(state, 'rebase_verify', 'pr_graduation')).toEqual({
      allowed: false,
      reason: 'pr_requires_post_rebase_verification',
    });
    expect(() => assertActionAllowed(withMode(state, 'pr_graduation'), 'pr_graduation', 'open_pull_request')).toThrow(
      /pr_requires_post_rebase_verification/,
    );
  });

  it('returns to repo_targeting from curator_request only once the curator request is lodged', () => {
    const blocked = {
      ...createInitialState(),
      session: { ...createInitialState().session, current_mode: 'curator_request' },
      repo: {
        target_kind: 'existing_repo',
        blocked: true,
        write_authorized: false,
        wiring_manifest: { status: 'absent' },
        required_facilities_missing: ['wiring_manifest'],
      },
    } satisfies PgasNewState;

    expect(canTransition(blocked, 'curator_request', 'repo_targeting')).toEqual({
      allowed: false,
      reason: 'repo_targeting_return_requires_lodged_curator_request',
    });

    const lodged = {
      ...blocked,
      repo: { ...blocked.repo, curator_request_lodged: true },
    } satisfies PgasNewState;
    expect(canTransition(lodged, 'curator_request', 'repo_targeting')).toEqual({ allowed: true });
  });
});
