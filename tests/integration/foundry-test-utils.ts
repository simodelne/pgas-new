import type { TestHarness, TestHarnessSnapshot } from '@simodelne/pgas-server/testing.js';

// Domain synthesis runs a full in-process TypeScript typecheck + behavioral
// gate per stage (see domain-synthesis.ts:typecheckStageBody / runBehavioralGate),
// which is CPU-heavy. On the shared self-hosted CI runner the approve-flow's
// approve -> synthesize_domain_logic -> branch_write auto-continuation can be
// starved past a 2s poll deadline while the round is still executing (observed
// as a `waitForSnapshot` timeout with mode=domain_synthesis and no
// domain_synthesis.audit yet). Locally the same wait resolves in ~0.4-0.5s.
// Give the poll load-tolerant headroom, well under the 30s vitest testTimeout.
// Every call site polls for a predicate that SHOULD become true (positive
// wait), so a longer deadline never slows the happy path — the loop returns
// the instant the predicate holds.
const WAIT_FOR_SNAPSHOT_DEADLINE_MS = 15_000;

// A heavily-loaded shared CI runner can occasionally need more than the 15s
// default; `PGAS_TEST_WAIT_SNAPSHOT_MS` lets an operator extend the poll deadline
// without a code change. A valid positive integer overrides the default; anything
// else (unset / non-numeric / non-positive) falls back to it.
function waitSnapshotTimeoutMs(): number {
  const raw = process.env.PGAS_TEST_WAIT_SNAPSHOT_MS;
  if (raw !== undefined) {
    const parsed = Number.parseInt(raw, 10);
    if (Number.isFinite(parsed) && parsed > 0) {
      return parsed;
    }
  }
  return WAIT_FOR_SNAPSHOT_DEADLINE_MS;
}

export async function waitForSnapshot(
  harness: TestHarness,
  predicate: (snapshot: TestHarnessSnapshot) => boolean,
  label: string,
): Promise<TestHarnessSnapshot> {
  const deadline = Date.now() + waitSnapshotTimeoutMs();
  let latest = await harness.snapshot();

  while (!predicate(latest) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 20));
    latest = await harness.snapshot();
  }

  if (!predicate(latest)) {
    throw new Error(
      `Timed out waiting for ${label}. Latest mode=${latest.mode}, domain=${JSON.stringify(latest.domain)}`,
    );
  }

  return latest;
}

export function terminalActionNames(rounds: unknown[]): string[] {
  return rounds.flatMap((round) => {
    if (!round || typeof round !== 'object' || Array.isArray(round)) return [];
    const result = (round as { result?: unknown }).result;
    if (!result || typeof result !== 'object' || Array.isArray(result)) return [];
    const terminal = (result as { terminal?: unknown }).terminal;
    if (!terminal || typeof terminal !== 'object' || Array.isArray(terminal)) return [];
    const name = (terminal as { name?: unknown }).name;
    return typeof name === 'string' ? [name] : [];
  });
}
