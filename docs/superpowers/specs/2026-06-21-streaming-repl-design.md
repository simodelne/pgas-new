# Streaming REPL CLI — Design Spec
Date: 2026-06-21  
Status: approved

## Goal

Replace the generated `repl/index.ts` scaffold with a state-of-art CLI that renders live LLM output, shows real-time round progress, and drives structured decision widgets via interactive menus — using pgas-server's SSE trigger stream and WebSocket notification channel.

---

## Problem with current scaffold

- `controlCliAdapter` owns stdin/stdout but never renders `widget_output` from LLM actions
- No progress indicator during LLM rounds (5–60 s of silence)
- JSON server logs bleed onto stdout
- `controlCliAdapter` embeds its own `createPgasServer()` — architecturally wrong; pgas-server is a separate process by definition
- `user_confirmation` channel has no REPL path — structured decisions are unreachable

---

## Architecture

### Files changed

| File | Change |
|---|---|
| `templates/pgas-new/standalone/src/repl/index.ts.tmpl` | Full rewrite — pure HTTP+WS client |
| `templates/pgas-new/standalone/src/repl/renderer.ts.tmpl` | New file — event→clack rendering |
| `templates/pgas-new/standalone/package.json.tmpl` | Add `@clack/prompts ^0.9`, `chalk ^5` |

### Runtime wiring

```
stdin
  │
  ▼
readline loop ──── /command ──▶ client.controls.invoke()  (HTTP)
                │
                └── free text ──▶ client.sessions.create()  (if no active session)
                                        │
                                        ▼
                                client.sessions.triggerStream()
                                        │
                          SSE events ───┘
                          round_start / step / round_complete
                                        │
                                        ▼
                                renderer.ts → @clack spinner + note

connectNotifications(ws)   — persistent WebSocket
  ├── mode_change           → @clack.log.step()
  ├── session:pending_input → renderWidget() → @clack select/text menu
  ├── session_terminal      → @clack.outro() + exit(0)
  └── error                 → @clack.log.error()
```

### No embedded server

`createPgasServer()` is removed from the REPL entirely. The REPL is a pure client:

```
PGAS_API_BASE   http://localhost:3000   (default)
PGAS_WS_BASE    derived: http→ws, https→wss  (or explicit override)
PGAS_CLI_TOKEN  dev-token  (devMode default; required otherwise)
PGAS_DEV_MODE   1  (default)
```

---

## Input layer (index.ts)

### Line classification

```
/command        → HTTP control invoke via control catalog
y/n/number      → intercepted by active @clack prompt (never hits readline)
free text       → triggerStream on active session; create session first if none
```

### Prompt states

```
›               idle — no active session
› [outline]     session active — current mode shown inline
⠸               spinner active (LLM responding) — readline suspended
```

Readline is **suspended while SSE is open**. Keystrokes queue until `round_complete`, then prompt returns. Prevents mid-round double triggers.

### In-memory state

```ts
type ReplState = {
  sessionId: string | null;
  mode:      string | null;
  running:   boolean;        // true while SSE open
  awaitingInput: boolean;    // true after session:pending_input fires
}
```

WS `mode_change` updates `state.mode` live — prompt label always reflects current mode without polling.

---

## Output layer (renderer.ts)

### SSE path (per-trigger)

| SSE event | @clack output |
|---|---|
| `round_start` | `ora` spinner start: "Thinking…" |
| `step: ingestion` | spinner text: "reading context…" |
| `step: authorship` | spinner text: "drafting response…" |
| `step: execution` | spinner text: "applying action…" |
| `round_complete` | spinner stop → `renderAction(result)` |
| `error` | spinner stop → `@clack.log.error()` |

### WS path (lifecycle)

| WS event | @clack output |
|---|---|
| `mode_change` | `@clack.log.step("→ outline")` |
| `session:pending_input` | `renderWidget(normalizedWidget)` |
| `session_terminal` | `@clack.outro("Complete.")` + exit |
| `error` | `@clack.log.error(message)` |

### `renderAction(result)` — generic, program-agnostic

- **Any MSet/field action** (e.g. `record_intake`) → `@clack.note()` with `key: value` table of payload fields
- **Array payload** (e.g. `propose_outline`) → `@clack.note()` with numbered list
- **`request_user_input`** → `@clack.log.info(payload.message)`
- **`__fallback__`** → `@clack.log.warn("No valid action — try rephrasing or /abort.")`

### `renderWidget(normalizedWidget)` — drives interactive menus

```
widget_type: confirm / user_confirmation
  └──▶ @clack.select({ message, options: [Approve, Reject, Add note] })
        → client.sessions.trigger(id, {
            channel: 'user_confirmation',
            payload: { decision: 'approve'|'reject', instruction: note }
          })

widget_type: form / text
  └──▶ @clack.text() for each field in normalizedWidget.fields
        → client.sessions.trigger(id, { channel: 'user_text', payload: answers })

widget_type: status / info
  └──▶ @clack.log.info(message)
```

Renderer never touches `process.stdout` directly — all output through `@clack/prompts` so box-drawing and colour stay consistent.

---

## Error handling & lifecycle

### Startup sequence

```
1. @clack.intro(`${PROGRAM_NAME} — PGAS REPL`)
2. GET /health — unreachable → @clack.cancel("Server not reachable") + exit(1)
3. connectNotifications(ws) — wait for 'connected' handshake
4. Print current mode + available controls hint
5. Show prompt ›
```

### WS reconnect

Pass `reconnect: true` to `connectNotifications`. On exhausted retries:
```
@clack.log.warn("Connection lost — run /resume when server is back")
```
Input suspended. No crash.

### `/abort` guard

If `state.running === true` → `@clack.confirm("Abort the running session?")` before calling `client.sessions.abort()`.

### SIGINT

Session running → confirm abort first. Idle → `@clack.outro("Bye.")` + exit(0).

### `__fallback__`

Detected in `renderAction`. Prints warn, returns prompt immediately — user can retry.

---

## Example terminal session

```
┌  Legal Fee Proposals
│
◇  Connected — mode: intake
│
› I need a legal fee proposal for SimoneOS. Objectives: fixed-fee
  billing for AI audits. Policy type: fixed-fee w/ cap...

  ⠸ reading context… authorship… applying action…

◇  Intake recorded
│  objectives   fixed-fee billing for AI system audits
│  policy_type  fixed-fee with contingency cap
│  org          SimoneOS Ltd, Series A, UAE/Bahrain
│  risk         low — capped exposure
│  budget       AED 50,000 / engagement
│  audience     C-suite and board
│  jurisdiction UAE Federal Law, DIFC, Bahrain NBB

◇  → outline

  ⠸ drafting response…

◆  Approve this outline?
│  1. Executive Summary & Engagement Overview
│  2. Scope of Services: AI System Audits
│  3. Fixed-Fee Structure & Billing Model
│  4. Regulatory Compliance (UAE / DIFC / Bahrain)
│  5. Risk Allocation & Liability Caps
│  6. Engagement Timeline & Milestones
│  7. Approval & Signature Block
│
○  › Approve
○    Reject with note
○    Add revision instructions

└  Complete.
```

---

## Scope boundaries

- **In scope:** `repl/index.ts.tmpl`, `repl/renderer.ts.tmpl`, `package.json.tmpl`
- **Out of scope:** server template, test templates, program spec/handler/tools templates
- **Not in scope:** i18n, persistent session history across REPL restarts, multi-program switching within one REPL session
