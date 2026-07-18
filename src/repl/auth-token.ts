import { isRecord } from '../util/guards.js';
/**
 * Decode a JWT's `exp` claim (seconds since the epoch) without verifying the
 * signature. Returns `undefined` when the token is malformed, the payload is
 * missing, or `exp` is absent/non-finite.
 *
 * Shared by the CLI (token-expiry messaging) and the REPL runner (discarding
 * expired cached tokens); keep this the single source of truth for both.
 */
export function decodeJwtExp(token: string): number | undefined {
  const [, payload] = token.split('.');
  if (!payload) return undefined;

  try {
    const decoded = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as unknown;
    return isRecord(decoded) && typeof decoded.exp === 'number' && Number.isFinite(decoded.exp)
      ? decoded.exp
      : undefined;
  } catch {
    return undefined;
  }
}
