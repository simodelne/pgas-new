import type { TestHarness, TestHarnessSnapshot } from '@simodelne/pgas-server/testing.js';

// Several foundry gate steps (notably approve_artifact_plan -> domain_synthesis
// -> branch_write) complete their forward progress via the engine's ASYNC
// NoticeContinuation bus consumer: harness.trigger() returns after the first
// round (~10ms), then the consumer fires a fresh system_mode_entry trigger that
// runs synthesize_domain_logic. That continuation round does real TypeScript
// verification work (transpile + ts.createProgram typecheck + a behavioral VM
// gate per stage), which is legitimately slow-but-correct: ~400ms unloaded and,
// under CI CPU contention, 900-1300ms+ (measured). It ALWAYS completes and
// reaches the asserted state; only the poll window was too tight.
//
// The previous hard 2_000ms deadline left almost no headroom on a loaded
// shared CI runner, producing the intermittent
// "Timed out waiting for artifact plan approval to domain synthesis
// completion. Latest mode=domain_synthesis" flake. This is a TEST-SIDE wait
// budget for a genuinely-async-but-reliable continuation, not a product
// timeout: a satisfied predicate still returns immediately, so raising the
// ceiling only affects the (rare) timeout error path. Keep it overridable so
// especially strained runners can extend it without a code change.
const DEFAULT_WAIT_SNAPSHOT_TIMEOUT_MS = 15_000;

function waitSnapshotTimeoutMs(): number {
  const raw = process.env.PGAS_TEST_WAIT_SNAPSHOT_MS;
  if (raw !== undefined) {
    const parsed = Number.parseInt(raw, 10);
    if (Number.isFinite(parsed) && parsed > 0) {
      return parsed;
    }
  }
  return DEFAULT_WAIT_SNAPSHOT_TIMEOUT_MS;
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
