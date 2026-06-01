import { useEffect, useState } from 'react';
import { useAuthStore } from '../stores/auth';
import { api, ApiError } from '../lib/api';
import { navigate } from '../lib/navigate';

/**
 * Handles `#/auth/magic/:token`. Hits GET /auth/magic/:token, stashes
 * the returned JWT, then navigates to the session list. On failure
 * (expired / already redeemed / wrong mode), shows a Try-again link.
 *
 * Only used when VITE_PGAS_AUTH_MODE=magic-link. In dev-static-token
 * mode, the server returns 404 from /auth/magic/* and the user sees
 * the error UI here.
 */
export default function MagicLinkCallback({ token }: { token: string }) {
  const login = useAuthStore((s) => s.login);
  const [status, setStatus] = useState<'redeeming' | 'ok' | 'error'>('redeeming');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await api.redeemMagicLink(token);
        if (cancelled) return;
        login({
          token: res.jwt,
          email: res.user_email,
          expiresAt: res.expires_at,
        });
        setStatus('ok');
        navigate('/');
      } catch (err) {
        if (cancelled) return;
        setError(err instanceof ApiError ? err.message : 'Could not redeem link.');
        setStatus('error');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [token, login]);

  return (
    <div className="min-h-screen flex items-center justify-center p-6">
      <div className="w-full max-w-md rounded-xl border border-slate-700 bg-slate-900/60 p-8 text-center shadow-lg backdrop-blur">
        {status === 'redeeming' ? (
          <>
            <p className="text-sm text-slate-300">Signing you in…</p>
          </>
        ) : status === 'error' ? (
          <>
            <h2 className="mb-2 text-lg font-semibold text-red-300">Sign-in failed</h2>
            <p className="mb-4 text-sm text-slate-400">{error}</p>
            <button
              type="button"
              onClick={() => navigate('/')}
              className="text-sm text-blue-400 hover:text-blue-300"
            >
              Back to sign-in
            </button>
          </>
        ) : (
          <p className="text-sm text-slate-300">Signed in. Redirecting…</p>
        )}
      </div>
    </div>
  );
}
