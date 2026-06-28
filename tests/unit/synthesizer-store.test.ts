import { describe, expect, it } from 'vitest';
import {
  clearSynthesizedArtifact,
  getSynthesizedArtifact,
  putSynthesizedArtifact,
  type SynthesizedArtifact,
} from '../../src/foundry-program/synthesizer-store.js';

function artifact(specYaml: string, modeNames: string[]): SynthesizedArtifact {
  return {
    spec_yaml: specYaml,
    mode_names: modeNames,
    sha256: `sha-${modeNames.join('-')}`,
    created_at: '2026-06-22T00:00:00.000Z',
    contracts_ts: 'export const stageActionContracts = [];',
    handlers_ts: 'export const handlers = {};',
    handlers_index_ts: 'export const handlers = {};',
    tools_ts: 'export function registerProgramTools() {}',
    smoke_test_ts: 'describe("generated program smoke", () => {});',
    stage_classification: [],
    body_stage_slugs: [],
  };
}

describe('synthesizer transit store', () => {
  it('puts, gets, and deletes artifacts by session id', () => {
    const stored = artifact('name: alpha', ['intake', 'triage', 'done']);

    putSynthesizedArtifact('session-a', stored);

    expect(getSynthesizedArtifact('session-a')).toEqual(stored);

    clearSynthesizedArtifact('session-a');

    expect(getSynthesizedArtifact('session-a')).toBeUndefined();
  });

  it('keeps concurrent puts for different sessions isolated', () => {
    const first = artifact('name: alpha', ['a', 'b', 'c']);
    const second = artifact('name: beta', ['x', 'y', 'z']);

    putSynthesizedArtifact('session-a', first);
    putSynthesizedArtifact('session-b', second);

    expect(getSynthesizedArtifact('session-a')).toEqual(first);
    expect(getSynthesizedArtifact('session-b')).toEqual(second);
  });

  it('clears idempotently when no artifact exists for the session', () => {
    clearSynthesizedArtifact('missing-session');
    clearSynthesizedArtifact('missing-session');

    expect(getSynthesizedArtifact('missing-session')).toBeUndefined();
  });
});
