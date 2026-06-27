import { describe, expect, it } from 'vitest';
// Opt-in parallel-effect feature (v3.3). Two layers are pinned here:
//   1. the REAL published createCompositeEffectAdapter runtime contract
//      (parallel fan-out, one combined envelope, consumer-side partial-failure
//      aggregation), independent of the foundry; and
//   2. the foundry's run_parallel_static_checks runner, which packs pgas-new's
//      own governance checks into that adapter.
import { createCompositeEffectAdapter } from '@simodelne/pgas-server/plugin.js';
import { runCompositeStaticChecks } from '../../src/foundry-program/composite-checks.js';

describe('createCompositeEffectAdapter (published opt-in contract)', () => {
  it('fans out children in parallel and returns ONE combined envelope', async () => {
    const order: string[] = [];
    const adapter = createCompositeEffectAdapter('composite_probe', [
      {
        id: 'a',
        run: async () => {
          await new Promise((r) => setTimeout(r, 40));
          order.push('a');
          return { ok: true };
        },
      },
      {
        id: 'b',
        run: async () => {
          await new Promise((r) => setTimeout(r, 40));
          order.push('b');
          return { ok: true };
        },
      },
    ]);

    expect(adapter.id).toBe('composite_probe');

    const t0 = Date.now();
    const envelope = (await adapter.dispatch({} as never)) as {
      status: string;
      children: { id: string; status: string }[];
    };
    const elapsed = Date.now() - t0;

    // Parallel, not sequential: two 40ms children finish well under 80ms.
    expect(elapsed).toBeLessThan(80);
    expect(order.sort()).toEqual(['a', 'b']);
    expect(envelope.status).toBe('succeeded');
    expect(envelope.children).toHaveLength(2);
    expect(envelope.children.every((c) => c.status === 'succeeded')).toBe(true);
  });

  it('aggregates a single child failure to status "partial" without throwing', async () => {
    const adapter = createCompositeEffectAdapter('composite_probe_partial', [
      { id: 'ok', run: async () => ({ ok: true }) },
      {
        id: 'boom',
        run: async () => {
          throw new Error('child failed on purpose');
        },
      },
    ]);

    const envelope = (await adapter.dispatch({} as never)) as {
      status: string;
      children: { id: string; status: string; error?: { message?: string } }[];
    };

    expect(envelope.status).toBe('partial');
    expect(envelope.children.find((c) => c.id === 'ok')?.status).toBe('succeeded');
    const failed = envelope.children.find((c) => c.id === 'boom');
    expect(failed?.status).toBe('failed');
    expect(failed?.error?.message).toContain('child failed on purpose');
  });
});

describe('run_parallel_static_checks (foundry opt-in handler path)', () => {
  it('packs the three governance checks into ONE succeeded envelope when all pass', async () => {
    const envelope = await runCompositeStaticChecks({
      imports: [
        '@simodelne/pgas-server/plugin.js',
        '@simodelne/pgas-server/create-server.js',
      ],
      modes: ['intake', 'working', 'complete'],
      evidence: { status: 'passed', evidence_id: 'ev-123' },
    });

    expect(envelope.status).toBe('succeeded');
    expect(envelope.children.map((c) => c.id).sort()).toEqual([
      'evidence_shape',
      'import_boundary',
      'spec_modes',
    ]);
    expect(envelope.children.every((c) => c.status === 'succeeded')).toBe(true);
    const importChild = envelope.children.find((c) => c.id === 'import_boundary');
    expect(importChild?.output).toMatchObject({ scanned: 2, violations: 0 });
  });

  it('aggregates to "partial" when one packed check fails, leaving the others succeeded', async () => {
    const envelope = await runCompositeStaticChecks({
      // A banned engine-internal import → import_boundary child fails.
      imports: ['@simodelne/pgas-server/plugin.js', '@simodelne/pgas-runtime/internal.js'],
      modes: ['intake', 'complete'],
      evidence: { status: 'passed', evidence_id: 'ev-456' },
    });

    expect(envelope.status).toBe('partial');
    const importChild = envelope.children.find((c) => c.id === 'import_boundary');
    expect(importChild?.status).toBe('failed');
    expect(importChild?.error?.message).toContain('disallowed import');
    // The independent checks still succeed — failure is isolated per child.
    expect(envelope.children.find((c) => c.id === 'spec_modes')?.status).toBe('succeeded');
    expect(envelope.children.find((c) => c.id === 'evidence_shape')?.status).toBe('succeeded');
  });

  it('fails the evidence_shape child when packed evidence lacks required fields', async () => {
    const envelope = await runCompositeStaticChecks({
      imports: [],
      modes: ['intake', 'blocked'],
      evidence: { status: 'passed' }, // missing evidence_id
    });

    expect(envelope.status).toBe('partial');
    expect(envelope.children.find((c) => c.id === 'evidence_shape')?.status).toBe('failed');
  });
});
