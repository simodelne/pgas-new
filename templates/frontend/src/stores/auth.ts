// Vendored from simoneos/frontend/src/stores/auth.ts (snapshot
// 2026-06-01). Trimmed: drops admin role + displayName because v0.1
// plugin scaffolds don't need a /me profile yet. Add them back when
// your consumer needs them.

import { create } from 'zustand';
import { readAuthBlob, writeAuthBlob, clearAuthBlob, type AuthBlob } from '../lib/auth';

interface AuthState {
  token: string | null;
  email: string | null;
  userId: string | null;
  login: (blob: AuthBlob) => void;
  logout: () => void;
}

const initial = readAuthBlob();

export const useAuthStore = create<AuthState>((set) => ({
  token: initial?.token ?? null,
  email: initial?.email ?? null,
  userId: initial?.userId ?? null,
  login: (blob) => {
    writeAuthBlob(blob);
    set({
      token: blob.token,
      email: blob.email ?? null,
      userId: blob.userId ?? null,
    });
  },
  logout: () => {
    clearAuthBlob();
    set({ token: null, email: null, userId: null });
  },
}));
