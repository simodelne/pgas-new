import { describe, expect, it } from 'vitest';
import { createInitialState, type PgasNewState } from '../../src/pgas-new/model.js';
import { assertActionAllowed, canTransition, legalActionsForMode } from '../../src/pgas-new/gates.js';

function existingRepoState(): PgasNewState {
  return {
    ...createInitialState(),
    repo: {
      ...createInitialState().repo,
      target_kind: 'existing_repo',
      wiring_manifest: { status: 'valid', path: '.pgas/wiring.yml' },
    },
    program: {
      ...createInitialState().program,
      slug: 'legal-rag',
      name: 'Legal RAG',
    },
    artifact_plan: {
      status: 'approved',
      artifacts: [],
    },
  };
}

describe('pgas-new gates', () => {
  it('allows the happy-path transition ladder when prerequisites are met', () => {
    const state = existingRepoState();

    expect(canTransition(state, 'intake_intelligence', 'repo_targeting')).toMatchObject({ allowed: true });
    expect(canTransition(state, 'repo_targeting', 'architecture_design')).toMatchObject({ allowed: true });
    expect(canTransition(state, 'architecture_design', 'scaffold_plan')).toMatchObject({ allowed: true });
    expect(canTransition(state, 'scaffold_plan', 'branch_write')).toMatchObject({ allowed: true });

    const written = { ...state, artifacts: { written: true, generated_paths: ['programs/legal-rag/specs.yml'] } };
    expect(canTransition(written, 'branch_write', 'static_verify')).toMatchObject({ allowed: true });

    const staticPassed = {
      ...written,
      graduation: {
        ...written.graduation,
        static_verification: 'passed',
        live_provider_intent: true,
      },
    } satisfies PgasNewState;
    expect(canTransition(staticPassed, 'static_verify', 'live_verify')).toMatchObject({ allowed: true });

    const livePassed = {
      ...staticPassed,
      graduation: { ...staticPassed.graduation, live_verification: 'passed' },
    } satisfies PgasNewState;
    expect(canTransition(livePassed, 'live_verify', 'rebase_verify')).toMatchObject({ allowed: true });

    const rebased = {
      ...livePassed,
      graduation: { ...livePassed.graduation, rebase_verification: 'passed' },
    } satisfies PgasNewState;
    expect(canTransition(rebased, 'rebase_verify', 'pr_graduation')).toMatchObject({ allowed: true });
  });

  it('blocks existing-repo writes without a valid fixed-path wiring manifest', () => {
    const state = {
      ...existingRepoState(),
      repo: {
        target_kind: 'existing_repo',
        wiring_manifest: { status: 'absent' },
        required_facilities_missing: [],
      },
    } satisfies PgasNewState;

    expect(canTransition(state, 'scaffold_plan', 'branch_write')).toEqual({
      allowed: false,
      reason: 'existing_repo_requires_valid_wiring_manifest',
    });
    expect(legalActionsForMode(state, 'repo_targeting')).toContain('create_curator_request');
  });

  it('blocks existing-repo writes when a valid manifest is not at the fixed path', () => {
    const state = {
      ...existingRepoState(),
      repo: {
        target_kind: 'existing_repo',
        wiring_manifest: { status: 'valid' },
        required_facilities_missing: [],
      },
    } satisfies PgasNewState;

    expect(canTransition(state, 'scaffold_plan', 'branch_write')).toEqual({
      allowed: false,
      reason: 'existing_repo_requires_fixed_path_wiring_manifest',
    });
  });

  it('routes absent or invalid repo facilities to curator_request', () => {
    const absent = {
      ...createInitialState(),
      repo: { target_kind: 'existing_repo', wiring_manifest: { status: 'absent' }, required_facilities_missing: [] },
    } satisfies PgasNewState;
    const invalid = {
      ...absent,
      repo: {
        target_kind: 'existing_repo',
        wiring_manifest: { status: 'invalid', errors: ['pgas.allowed_imports contains a private import'] },
        required_facilities_missing: [],
      },
    } satisfies PgasNewState;
    const missingFacility = {
      ...absent,
      repo: {
        target_kind: 'existing_repo',
        wiring_manifest: { status: 'valid', path: '.pgas/wiring.yml' },
        required_facilities_missing: ['registration_marker'],
      },
    } satisfies PgasNewState;

    expect(canTransition(absent, 'repo_targeting', 'curator_request')).toMatchObject({ allowed: true });
    expect(canTransition(invalid, 'repo_targeting', 'curator_request')).toMatchObject({ allowed: true });
    expect(canTransition(missingFacility, 'repo_targeting', 'curator_request')).toMatchObject({ allowed: true });
  });

  it('only allows curator request creation when a repo blocker exists or while in curator_request mode', () => {
    const state = existingRepoState();

    expect(legalActionsForMode(state, 'repo_targeting')).not.toContain('create_curator_request');
    expect(() => assertActionAllowed(state, 'repo_targeting', 'create_curator_request')).toThrow(
      /curator_request_requires_repo_blocker/,
    );
    expect(() => assertActionAllowed(state, 'curator_request', 'create_curator_request')).not.toThrow();
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
    expect(legalActionsForMode(state, 'static_verify')).toEqual(
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

  it('requires static success and live-provider intent before live verification', () => {
    const state = {
      ...existingRepoState(),
      artifacts: { written: true, generated_paths: ['programs/legal-rag/specs.yml'] },
    } satisfies PgasNewState;

    expect(canTransition(state, 'static_verify', 'live_verify')).toEqual({
      allowed: false,
      reason: 'live_verify_requires_static_passed',
    });

    const staticPassed = {
      ...state,
      graduation: { ...state.graduation, static_verification: 'passed', live_provider_intent: false },
    } satisfies PgasNewState;
    expect(canTransition(staticPassed, 'static_verify', 'live_verify')).toEqual({
      allowed: false,
      reason: 'live_verify_requires_live_provider_intent',
    });
    expect(legalActionsForMode(staticPassed, 'live_verify')).not.toContain('run_api_blackbox_verification');
    expect(() => assertActionAllowed(staticPassed, 'live_verify', 'run_api_blackbox_verification')).toThrow(
      /live_verify_requires_live_provider_intent/,
    );
  });

  it('requires post-rebase verification before opening a pull request', () => {
    const state = existingRepoState();

    expect(canTransition(state, 'rebase_verify', 'pr_graduation')).toEqual({
      allowed: false,
      reason: 'pr_requires_post_rebase_verification',
    });
    expect(() => assertActionAllowed(state, 'pr_graduation', 'open_pull_request')).toThrow(
      /pr_requires_post_rebase_verification/,
    );
  });
});
