import { appTransport, createPgasClient, type PgasClient } from '@simodelne/pgas-server/client.js';
import {
  createPgasServer,
  type PgasServer,
  type PgasServerConfig,
} from '@simodelne/pgas-server/create-server.js';
import type { TestHarness, TestHarnessSnapshot } from '@simodelne/pgas-server/testing.js';

// ─────────────────────────── route-level harness ───────────────────────────
//
// Every hermetic route-level falsifier boots the SAME server + client scaffold:
// a `createPgasServer` with an injected scripted author handle + a noop observer,
// `devMode: true`, telemetry off, `port: 0` (no socket — the tests drive
// `server.app.fetch` through `appTransport`), then a `createPgasClient` over that
// app with a `dev-token`, then `server.close()` on teardown. Only the registered
// `programs`, the `authorHandle`, the observer's `modelId`, and (for upload/export/
// extraction) the `storage.uploadsDir` differ. `startRouteHarness` centralises the
// identical scaffold and takes those varying pieces as parameters. It deliberately
// does NOT manage the per-test temp directory / spec-entry lifecycle (those vary in
// creation and cleanup) — each caller keeps its own `mkdtempSync`/`rmSync`.

/** The provider handle shape both `authorHandle` and `observerHandle` satisfy. */
type CompletionHandle = { modelId?: string; complete(prompt: string): Promise<string> };

export interface RouteHarness {
  readonly server: PgasServer;
  readonly client: PgasClient;
  /** Graceful `server.close()`. Safe to call from a `finally`. */
  close(): Promise<void>;
}

export interface RouteHarnessOptions {
  /** Programs to register (`{ name, entry }` pairs). */
  programs: PgasServerConfig['programs'];
  /** The scripted author driver installed for hermetic completion. */
  authorHandle: CompletionHandle;
  /** `modelId` stamped on the noop observer handle. Default `'route-observer'`. */
  observerModelId?: string;
  /** Optional persistence/uploads config, e.g. `{ uploadsDir }`. */
  storage?: PgasServerConfig['storage'];
  /** Bearer token the client presents. Default `'dev-token'`. */
  token?: string;
}

/**
 * Boot the shared route-level harness (server + app-transport client) used by the
 * hermetic falsifier integration tests. Returns the live `server`, a `client`
 * bound to `server.app`, and a `close()` that shuts the server down.
 */
export async function startRouteHarness(options: RouteHarnessOptions): Promise<RouteHarness> {
  const server = await createPgasServer({
    programs: options.programs,
    drivers: {
      authorHandle: options.authorHandle,
      observerHandle: {
        modelId: options.observerModelId ?? 'route-observer',
        async complete() {
          return 'noop';
        },
      },
    },
    devMode: true,
    ...(options.storage ? { storage: options.storage } : {}),
    telemetry: { enabled: false },
    port: 0,
  });
  const client = createPgasClient(appTransport(server.app, { token: options.token ?? 'dev-token' }));
  return {
    server,
    client,
    close: () => server.close(),
  };
}

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
