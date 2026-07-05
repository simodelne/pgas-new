import { describe, expect, it } from 'vitest';
import { reactionHandlers } from '../../src/foundry-program/handlers.js';

// The generated live-drive gate is HARD-required for graduation: the
// live_verify -> rebase_verify path is blocked (via the
// run_live_provider_verification precondition) until
// graduation.generated_live_drive is exactly 'passed'. These tests pin the
// normalize reaction that owns that field: the DETERMINISTIC handler report
// (result_path graduation.generated_live_drive_report) must take precedence
// over the LLM-echoed `status` arg, so a mispredicted arg can neither fake a
// pass nor mask a failure.

describe('normalize_generated_live_drive_status', () => {
  const reaction = reactionHandlers.get('normalize_generated_live_drive_status');

  function run(entries: Array<[string, unknown]>): unknown {
    return reaction!(new Map<string, unknown>(entries), undefined as never, undefined as never);
  }

  it('is registered', () => {
    expect(reaction).toBeTypeOf('function');
  });

  it('applies the deterministic handler report status over an LLM-echoed pass', () => {
    expect(run([
      ['graduation.generated_live_drive', 'passed'],
      ['graduation.generated_live_drive_report', {
        kind: 'generated_live_drive_verification',
        status: 'failed',
        evidence_id: 'live-drive-x1',
      }],
    ])).toEqual({
      mutations: [
        { op: 'MSet', path: 'graduation.generated_live_drive', value: 'failed' },
        { op: 'MSet', path: 'graduation.generated_live_drive_evidence_id', value: 'live-drive-x1' },
      ],
    });
  });

  it('canonicalizes a report status synonym', () => {
    expect(run([
      ['graduation.generated_live_drive', 'pending'],
      ['graduation.generated_live_drive_report', { status: 'succeeded' }],
    ])).toEqual({
      mutations: [
        { op: 'MSet', path: 'graduation.generated_live_drive', value: 'passed' },
      ],
    });
  });

  it('canonicalizes an arg-recorded synonym when no handler report is present', () => {
    expect(run([
      ['graduation.generated_live_drive', 'succeeded'],
    ])).toEqual({
      mutations: [
        { op: 'MSet', path: 'graduation.generated_live_drive', value: 'passed' },
      ],
    });
  });

  it('returns no mutations when the report and recorded status already agree', () => {
    expect(run([
      ['graduation.generated_live_drive', 'passed'],
      ['graduation.generated_live_drive_evidence_id', 'live-drive-x1'],
      ['graduation.generated_live_drive_report', { status: 'passed', evidence_id: 'live-drive-x1' }],
    ])).toBeUndefined();
  });
});
