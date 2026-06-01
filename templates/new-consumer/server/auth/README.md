# server/auth/ — placeholder

This directory is intentionally minimal in plugin v0.1.

**Brief 2 (v0.2 of the plugin) will fill this in with:**

- `server/auth/dev-static-token.ts` — the default dev-token middleware
  (shipped enabled by default per locked architecture decision #2).
- `server/auth/magic-link.ts` — the documented opt-in magic-link flow.
- `server/auth/session-permanence.ts` — the SQLite-backed session store.
- A DB migration under `server/migrations/` for the session table.
- The auth section of `.env.example`.

**Until Brief 2 lands, the consumer's `server/index.ts` does NOT enforce
authentication.** The TODO marker in `server/index.ts.tmpl` indicates
where the auth middleware will plug in. Do not write auth code in
`server/index.ts` directly — wait for Brief 2 and use the dedicated
middleware that lands here.

If you need an interim auth solution (rare), use a single read-only
`X-Auth-Token` header compared against `process.env.AUTH_DEV_TOKEN`,
and put it in a SEPARATE middleware file (e.g.
`server/auth/_temp-token.ts`) so Brief 2 can replace it cleanly.

## References

- pgas issue tracker for Brief 2: TBD when filed
- Architecture decision rationale: see the plugin's
  `commands/pgas-new-consumer.md` step "Notes"
