# Mandate — social-media-agent

This MANDATE captures what v3.0's `synthesize_program_spec` action should produce when given this intake. The artifacts in this directory are the frozen v2.x baseline used for regression testing.

## Q1 Purpose
Manage a demo social media account through a mocked browser adapter with explicit human approval before any mocked publish action.

## Q2 Entry channel
user_text

## Q3 Stages
1. intake — Collect demo account handle, platform class, persona and voice rules, topic scope, posting cadence, and acknowledgement that no real credentials will be used.
2. mock_adapter_check — Confirm browser.adapter_kind is mock and halt on any real-adapter signal.
3. session_bootstrap — Drive the mock browser through the demo login page only.
4. monitor_feed — Observe the mock feed and notifications and record snapshot counts.
5. draft_review — Draft replies and posts for the captured feed snapshot with explicit intent and mock target URL.
6. human_approval — Present every draft to the user and only unlock publish on explicit approval.
7. post_publish — Publish exactly one approved draft per call through the mock browser.
8. post_verification — Verify the mock post landed and append to the durable post ledger.
9. complete — Report completion and the ledger location.
10. blocked — Report the precise block reason and the next user action required without bypass attempts.

## Q4 Decision points
- intake → mock_adapter_check when intake.complete = true
- intake → blocked when run.block_reason = true
- mock_adapter_check → session_bootstrap when browser.mock_confirmed = true
- mock_adapter_check → blocked when run.block_reason = true
- session_bootstrap → monitor_feed when session.mock_authenticated = true
- session_bootstrap → blocked when run.block_reason = true
- monitor_feed → draft_review when feed.snapshot_captured = true
- monitor_feed → blocked when run.block_reason = true
- draft_review → human_approval when draft.awaiting_approval = true
- draft_review → blocked when run.block_reason = true
- human_approval → post_publish when approval.user_approved = true
- human_approval → draft_review when draft.revision_requested = true
- human_approval → blocked when run.block_reason = true
- post_publish → post_verification when post.last_post_id = true
- post_publish → blocked when run.block_reason = true
- post_verification → draft_review when post.last_post_verified = true
- post_verification → complete when post.budget_exhausted = true
- post_verification → blocked when verification.requires_user_decision = true

## Q5 Delegation
none

## Q6 Completion criteria
- Terminal mode: complete
- Guard: post.budget_exhausted = true
