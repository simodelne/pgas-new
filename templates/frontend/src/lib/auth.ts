// Vendored from simoneos/frontend/src/stores/auth.ts patterns
// (snapshot 2026-06-01). The localStorage key is 'auth' and the value
// is a JSON blob with at minimum a `token` field. Both auth modes
// (dev-static-token and magic-link) end up writing the same shape so
// the API + WS clients can read the token uniformly.

export interface AuthBlob {
  token: string;
  // The fields below are optional — dev-static-token mode skips them
  // entirely. Magic-link mode populates them from /auth/magic/:token.
  userId?: string;
  email?: string;
  expiresAt?: number;
}

const KEY = 'auth';

export function readAuthBlob(): AuthBlob | null {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as AuthBlob;
    if (typeof parsed?.token !== 'string' || !parsed.token) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function writeAuthBlob(blob: AuthBlob): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(blob));
  } catch {
    // Private-mode storage is full or disabled — surface to caller via
    // a window event so the UI can render an error toast.
    window.dispatchEvent(new Event('auth-storage-error'));
  }
}

export function clearAuthBlob(): void {
  try {
    localStorage.removeItem(KEY);
  } catch {
    // ignore
  }
}

export function getToken(): string | null {
  return readAuthBlob()?.token ?? null;
}

export function authHeader(): Record<string, string> {
  const token = getToken();
  return token ? { Authorization: `Bearer ${token}` } : {};
}
