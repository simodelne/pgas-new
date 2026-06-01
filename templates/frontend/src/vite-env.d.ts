/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_PGAS_API_URL: string;
  readonly VITE_PGAS_WS_URL: string;
  readonly VITE_PGAS_AUTH_MODE: 'dev-static-token' | 'magic-link';
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
