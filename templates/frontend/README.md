# templates/frontend/ — vendored frontend snapshot

Minimal usable consumer UI, vendored from
[`simoneos/frontend/`](https://github.com/simodelne/simoneos) on
**2026-06-01**. Activated by the `--with-frontend` flag on
`/pgas-new-consumer`.

## What's in the snapshot

| Surface | File | Vendored from |
|---|---|---|
| Entry / router | `src/main.tsx`, `src/App.tsx.tmpl`, `src/components/Router.tsx` | adapted; no react-router dep |
| Login (both auth modes) | `src/pages/Login.tsx.tmpl`, `src/pages/MagicLinkCallback.tsx` | structure from `src/pages/v2/LoginPageV2.tsx` |
| Session list | `src/pages/SessionList.tsx.tmpl` | structure from `src/pages/v2/SessionsInventoryPage.tsx` |
| Single chat view | `src/pages/Chat.tsx.tmpl` | text-only seam; widget framework deliberately not vendored |
| Auth + API client | `src/lib/auth.ts`, `src/lib/api.ts.tmpl` | `src/stores/auth.ts` + `src/api/client.ts` |
| WS client | `src/lib/ws.ts` | `src/hooks/useWebSocket.ts` (simplified) |
| Hash-router helpers | `src/lib/navigate.ts` | adapted; tiny seam, separate from Router so react-refresh stays happy |
| State | `src/stores/auth.ts` | `src/stores/auth.ts` |
| Styling | `src/index.css` + `@tailwindcss/vite` plugin | `src/index.css` |

14 files under `src/` (counting `main.tsx`, `index.css`, and
`vite-env.d.ts`). The hard budget is 30 — every additional file
forces a discipline check before adding to the snapshot.

## Develop locally

```bash
cd frontend
cp .env.example .env.local        # edit VITE_PGAS_AUTH_MODE to match server
npm install
npm run dev                       # vite on :5173
```

The server (`../server/`) must be running too (default `:8787`). The
Vite dev proxy at `/api` and `/ws` is enabled only when
`VITE_PGAS_API_URL` / `VITE_PGAS_WS_URL` are relative paths. The
defaults are absolute (`http://localhost:8787`), so out of the box the
browser hits the backend directly with no proxy hop.

## Switching auth modes

Both modes are wired and live in the same vendored snapshot. Flip the
mode via two env vars (one server-side, one client-side):

| Mode | Server env (`.env.local`) | Client env (`frontend/.env.local`) |
|---|---|---|
| Dev-static-token | `PGAS_AUTH_MODE=dev-static-token` + `PGAS_DEV_STATIC_TOKEN=...` | `VITE_PGAS_AUTH_MODE=dev-static-token` |
| Magic-link | `PGAS_AUTH_MODE=magic-link` + `PGAS_JWT_SECRET=...` | `VITE_PGAS_AUTH_MODE=magic-link` |

The Login page reads `VITE_PGAS_AUTH_MODE` at build time (via
`import.meta.env`) and renders the matching form. The two values **must
match** — otherwise the client and server disagree about which endpoint
to call.

In magic-link mode + dev: the server logs the magic-link URL to its
console rather than emailing it. Copy the URL out of the server logs
into your browser to redeem.

## Pointing at a different pgas-server

Set both `VITE_PGAS_API_URL` and `VITE_PGAS_WS_URL` in
`frontend/.env.local`. Examples:

```bash
# Local backend on a non-default port
VITE_PGAS_API_URL=http://localhost:9090
VITE_PGAS_WS_URL=ws://localhost:9090/ws

# Production behind a reverse proxy, same origin as the frontend
VITE_PGAS_API_URL=/api
VITE_PGAS_WS_URL=/ws
```

## Refresh from upstream

The simoneos frontend drifts. The `simoneosFrontendSnapshot` field in
`.claude-plugin/plugin.json` records the date the snapshot was taken.
To refresh:

1. Read `~/Desktop/simoneos/frontend/src/` again — pay attention to
   `App.tsx`, `pages/v2/LoginPageV2.tsx`, `stores/auth.ts`,
   `hooks/useWebSocket.ts`, `api/client.ts`. These are the load-bearing
   files for the v0.1 vendored surfaces.
2. Identify the diffs that affect the **five surfaces** vendored here:
   login flow, session list, chat (text-only), WS client, API client.
3. Apply matching edits to `templates/frontend/`. Do NOT pull in
   simoneos-business-specific code (contracts, legal flows, widgets).
   The discipline check is the 30-file budget under `src/`.
4. Bump `simoneosFrontendSnapshot` in `.claude-plugin/plugin.json` to
   today's date.
5. Run `bash tests/template-render.test.sh` and
   `bash tests/frontend-scaffold.test.sh`. Both must pass.

## Excluded from the snapshot

To keep the surface minimal, the following simoneos features are
deliberately NOT vendored. Consumers who need them must opt-in
themselves:

- Widget framework (`src/primitives/`, `src/catalog/`, `src/runtime/`,
  `src/theme/`)
- Notification toast + issue reporter
- Tabs / multi-session shell (`src/stores/tabs.ts`, `V2Shell.tsx`)
- Domain patch / clause editor (`src/hooks/useClauseEditor.ts`, etc.)
- DOCX / audit-trail downloads
- OpenTelemetry browser SDK
- Admin / account / settings pages
- Surrogate bindings
- Long-session / stall detector / round-progress UI
- All `__tests__/` files (consumers add tests for their own surfaces)
