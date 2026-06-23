import type { TestHarness, TestHarnessSnapshot } from '@simodelne/pgas-server/testing.js';

export async function waitForSnapshot(
  harness: TestHarness,
  predicate: (snapshot: TestHarnessSnapshot) => boolean,
  label: string,
): Promise<TestHarnessSnapshot> {
  const deadline = Date.now() + 2_000;
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
