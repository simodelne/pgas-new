import { describe, expect, it } from 'vitest';
import { normalizeToolArgumentKeys } from '../../src/foundry-program/registration.js';

describe('#68 tool argument key normalization', () => {
  it('trims trailing-whitespace keys to their canonical form', () => {
    const result = normalizeToolArgumentKeys({
      q2_entry_channel: 'http',
      'message ': 'Q2 entry channel recorded.',
    }) as Record<string, unknown>;

    expect(Object.keys(result)).toEqual(['q2_entry_channel', 'message']);
    expect(result.message).toBe('Q2 entry channel recorded.');
    expect(result).not.toHaveProperty('message ');
  });

  it('trims leading-whitespace keys too', () => {
    const result = normalizeToolArgumentKeys({ ' slug': 'foo' }) as Record<string, unknown>;
    expect(Object.keys(result)).toEqual(['slug']);
    expect(result.slug).toBe('foo');
  });

  it('leaves clean payloads untouched (identity)', () => {
    const input = { slug: 'foo', name: 'Foo', target_dir: '/tmp/foo' };
    expect(normalizeToolArgumentKeys(input)).toBe(input);
  });

  it('rejects a whitespace key that collides with a distinct existing value', () => {
    expect(() =>
      normalizeToolArgumentKeys({ message: 'real', 'message ': 'shadow' }),
    ).toThrow(/whitespace_collision/u);
  });

  it('tolerates a whitespace key that duplicates an identical value', () => {
    const result = normalizeToolArgumentKeys({
      message: 'same',
      'message ': 'same',
    }) as Record<string, unknown>;
    expect(Object.keys(result)).toEqual(['message']);
    expect(result.message).toBe('same');
  });

  it('rejects a key that is only whitespace', () => {
    expect(() => normalizeToolArgumentKeys({ '   ': 'x' })).toThrow(/blank_after_trim/u);
  });

  it('passes through non-object payloads unchanged', () => {
    expect(normalizeToolArgumentKeys('str')).toBe('str');
    expect(normalizeToolArgumentKeys(null)).toBe(null);
    const arr = [1, 2];
    expect(normalizeToolArgumentKeys(arr)).toBe(arr);
  });
});
