/**
 * Shared pure type guards for the foundry runtime.
 *
 * These are the single source of truth for the guards that were previously
 * copy-defined across many modules. Template-embedded copies inside generated
 * scaffold/runner source strings intentionally stay self-contained (generated
 * standalone programs cannot import from the foundry's `src/`).
 */

/** Narrow an `unknown` value to a non-null, non-array object. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
