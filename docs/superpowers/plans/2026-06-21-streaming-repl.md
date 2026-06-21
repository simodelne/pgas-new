# Streaming REPL CLI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the generated REPL scaffold with a pure HTTP+WS client that renders LLM output live via SSE progress steps and WebSocket lifecycle events, with `@clack/prompts` interactive menus for structured decisions.

**Architecture:** `npm run repl` is a pure client — no embedded server. Two output channels: `triggerStream()` SSE drives per-round progress (spinner + `renderAction`); `connectNotifications()` WebSocket drives lifecycle (`mode_change`, `session:pending_input` menus, `session_terminal`). A new `renderer.ts` file owns all `@clack/prompts` rendering, keeping `index.ts` as pure wiring.

**Tech Stack:** TypeScript/Node ESM, `@simodelne/pgas-server/client.js`, `@clack/prompts ^0.9`, `chalk ^5`, Node built-in `readline`.

## Global Constraints

- All template files live under `templates/pgas-new/standalone/`
- Template tokens use `{{TOKEN}}` syntax — every declared token must appear in the template source; unused tokens throw at render time
- Import from `@simodelne/pgas-server/client.js` only (not `/channels/index.js` or `/create-server.js`) — the REPL is a pure client
- No `createPgasServer()` call in the REPL template
- No banned imports: `@simodelne/pgas-server/api`, `/src/*`, `@simodelne/pgas-runtime`
- Generated scaffold must typecheck with `tsc --noEmit` and pass `npm test`
- Run `npm test` from `/home/simone/pgas-new` after each task to verify nothing is broken
- Test runner: `npx vitest run --config tests/vitest.config.ts` for unit tests only

---

### Task 1: Add `renderer.ts.tmpl` and register it in the artifact system

**Files:**
- Create: `templates/pgas-new/standalone/src/repl/renderer.ts.tmpl`
- Modify: `src/pgas-new/artifact-plan.ts` — add `src/repl/renderer.ts` artifact
- Modify: `src/pgas-new/template-renderer.ts` — add renderer entry to `STANDALONE_TEMPLATE_BY_PATH`
- Modify: `tests/unit/template-renderer.test.ts` — replace REPL dev-auth test with streaming REPL test

**Interfaces:**
- Produces: `renderAction(result)`, `renderWidget(widget, trigger)`, `renderModeChange(mode)`, `renderError(msg)`, `ReplState` type — all consumed by Task 2's `index.ts.tmpl`

- [ ] **Step 1: Write the failing test** (replace the `renders REPL with a dev-mode AuthProvider` test at line 536)

Open `tests/unit/template-renderer.test.ts`. Find and replace the test starting at line 536 (`it('renders REPL with a dev-mode AuthProvider...`). Replace the entire `it(...)` block with:

```typescript
  it('renders streaming REPL client with SSE + WS rendering', () => {
    const outDir = mkdtempSync(join(tmpdir(), 'pgas-new-streaming-repl-'));
    try {
      renderStandaloneScaffold({
        outDir,
        slug: 'my-program',
        name: 'My Program',
      });

      const index = readFileSync(join(outDir, 'src/repl/index.ts'), 'utf8');
      const renderer = readFileSync(join(outDir, 'src/repl/renderer.ts'), 'utf8');
      const pkg = readFileSync(join(outDir, 'package.json'), 'utf8');

      // index.ts: pure client — no embedded server
      expect(index).not.toContain('createPgasServer');
      expect(index).not.toContain('controlCliAdapter');
      expect(index).not.toContain('devReplAuthProvider');
      expect(index).toContain("from '@simodelne/pgas-server/client.js'");
      expect(index).toContain('connectNotifications');
      expect(index).toContain('triggerStream');
      expect(index).toContain('PGAS_API_BASE');
      expect(index).toContain('PGAS_WS_BASE');
      expect(index).toContain('my-program');  // {{SLUG}} rendered
      expect(index).toContain('My Program');  // {{NAME}} rendered

      // renderer.ts: rendering functions exported
      expect(renderer).toContain('renderAction');
      expect(renderer).toContain('renderWidget');
      expect(renderer).toContain('renderModeChange');
      expect(renderer).toContain('renderError');
      expect(renderer).toContain('ReplState');
      expect(renderer).toContain("from '@clack/prompts'");
      expect(renderer).toContain("from 'chalk'");

      // package.json: new deps
      expect(pkg).toContain('@clack/prompts');
      expect(pkg).toContain('chalk');

      // no unresolved tokens
      expect(index).not.toContain('{{');
      expect(renderer).not.toContain('{{');
    } finally {
      rmSync(outDir, { recursive: true, force: true });
    }
  });
```

- [ ] **Step 2: Run the test to confirm it fails**

```bash
cd /home/simone/pgas-new
npx vitest run --config tests/vitest.config.ts tests/unit/template-renderer.test.ts 2>&1 | tail -20
```

Expected: FAIL — `renderer.ts` not in written artifacts, `createPgasServer` still in index.

- [ ] **Step 3: Create `templates/pgas-new/standalone/src/repl/renderer.ts.tmpl`**

Create the file (no template tokens — this file is program-agnostic):

```typescript
import { log, note, outro, select, text } from '@clack/prompts';
import chalk from 'chalk';

export interface ReplState {
  sessionId: string | null;
  mode: string | null;
  running: boolean;
  awaitingInput: boolean;
}

export interface ActionResult {
  name: string;
  channel?: string;
  payload?: Record<string, unknown>;
}

export interface NormalizedWidget {
  widget_type: string;
  message: string;
  intent: string;
  fields: Array<{ name: string; label: string; type?: string }>;
  round_number: number;
}

export function renderAction(result: ActionResult): void {
  const { name, payload = {} } = result;

  if (name === '__fallback__') {
    log.warn('No valid action — try rephrasing or /abort.');
    return;
  }

  // Array payload — e.g. proposed outline sections
  const firstArr = Object.values(payload).find((v) => Array.isArray(v));
  if (Array.isArray(firstArr)) {
    const lines = (firstArr as Array<Record<string, unknown>>)
      .map((item, i) => `${String(i + 1).padStart(2)}. ${String(item.title ?? item.name ?? JSON.stringify(item))}`)
      .join('\n');
    note(lines, chalk.bold(name.replace(/_/g, ' ')));
    return;
  }

  // Single message string
  if (typeof payload.message === 'string') {
    log.info(payload.message);
    return;
  }

  // Generic key/value table
  const fields = Object.entries(payload)
    .filter(([, v]) => v !== null && v !== undefined && v !== '')
    .map(([k, v]) => `${chalk.dim(k.padEnd(20))} ${String(v).slice(0, 80)}`)
    .join('\n');

  if (fields) {
    note(fields, chalk.bold(name.replace(/_/g, ' ')));
  }
}

export async function renderWidget(
  widget: NormalizedWidget,
  trigger: (channel: string, payload: unknown) => Promise<void>,
): Promise<void> {
  const { widget_type, message, intent, fields } = widget;

  const isConfirmation =
    widget_type === 'confirm' ||
    intent === 'present_for_approval' ||
    intent === 'approval' ||
    intent === 'confirm';

  if (isConfirmation) {
    const answer = await select<string>({
      message,
      options: [
        { value: 'approve', label: '✓  Approve' },
        { value: 'reject', label: '✗  Reject with note' },
        { value: 'skip', label: '·  Skip for now' },
      ],
    });
    if (typeof answer === 'symbol') return;

    let instruction = '';
    if (answer === 'reject') {
      const rev = await text({ message: 'Revision note (optional):' });
      if (typeof rev === 'symbol') return;
      instruction = String(rev);
    }

    await trigger('user_confirmation', {
      decision: answer === 'approve' ? 'approve' : 'reject',
      instruction,
      note_mode: 'inline',
      timestamp: new Date().toISOString(),
    });
    return;
  }

  // Form: prompt each declared field
  if (fields && fields.length > 0) {
    const answers: Record<string, string> = {};
    for (const field of fields) {
      const val = await text({ message: field.label, placeholder: field.name });
      if (typeof val === 'symbol') return;
      answers[field.name] = String(val);
    }
    await trigger('user_text', Object.entries(answers).map(([k, v]) => `${k}: ${v}`).join('\n'));
    return;
  }

  log.info(message);
}

export function renderModeChange(newMode: string): void {
  log.step(chalk.cyan(`→ ${newMode}`));
}

export function renderError(message: string): void {
  log.error(chalk.red(message));
}
```

- [ ] **Step 4: Add `src/repl/renderer.ts` artifact to `src/pgas-new/artifact-plan.ts`**

In `src/pgas-new/artifact-plan.ts`, find the `repl` artifact entry (line 84):
```typescript
artifact('repl', 'src/repl/index.ts', 'Expose the control-plane CLI REPL using controlCliAdapter.', 'branch_write', [
  'control-plane-test',
]),
```

Replace it with two entries:
```typescript
artifact('repl', 'src/repl/index.ts', 'Stream-rendering REPL client using SSE triggers and WebSocket lifecycle events.', 'branch_write', [
  'control-plane-test',
]),
artifact('repl', 'src/repl/renderer.ts', 'Maps PGAS session events to @clack/prompts output — renderAction, renderWidget, renderModeChange, renderError.', 'branch_write', [
  'control-plane-test',
]),
```

- [ ] **Step 5: Register `renderer.ts` in `src/pgas-new/template-renderer.ts`**

In `src/pgas-new/template-renderer.ts`, find `STANDALONE_TEMPLATE_BY_PATH` (around line 44). Add one entry after the `'src/repl/index.ts'` line:

```typescript
  'src/repl/renderer.ts': spec('standalone/src/repl/renderer.ts.tmpl', []),
```

- [ ] **Step 6: Run the test again — expect partial progress**

```bash
npx vitest run --config tests/vitest.config.ts tests/unit/template-renderer.test.ts 2>&1 | grep -E "PASS|FAIL|renderer|index|clack"
```

Expected: still FAIL — renderer.ts now present and has right content, but index.ts still has old content and package.json missing clack. Progress visible in which assertions pass.

- [ ] **Step 7: Commit template file and registrations**

```bash
git add templates/pgas-new/standalone/src/repl/renderer.ts.tmpl \
        src/pgas-new/artifact-plan.ts \
        src/pgas-new/template-renderer.ts \
        tests/unit/template-renderer.test.ts
git commit -m "feat: add renderer.ts.tmpl + register in artifact plan and renderer map"
```

---

### Task 2: Rewrite `index.ts.tmpl` as a pure streaming REPL client

**Files:**
- Modify: `templates/pgas-new/standalone/src/repl/index.ts.tmpl` — full rewrite
- Modify: `src/pgas-new/template-renderer.ts` — update token list for `src/repl/index.ts` from `['PASCAL_NAME', 'SLUG']` to `['NAME', 'SLUG']`

**Interfaces:**
- Consumes: `renderAction`, `renderWidget`, `renderModeChange`, `renderError`, `ReplState`, `NormalizedWidget` from `./renderer.js` (Task 1)
- Consumes: `createPgasClient`, `fetchTransport`, `connectNotifications` from `@simodelne/pgas-server/client.js`

- [ ] **Step 1: Update token declaration in `src/pgas-new/template-renderer.ts`**

Find line (around 55):
```typescript
  'src/repl/index.ts': spec('standalone/src/repl/index.ts.tmpl', ['PASCAL_NAME', 'SLUG']),
```

Replace with:
```typescript
  'src/repl/index.ts': spec('standalone/src/repl/index.ts.tmpl', ['NAME', 'SLUG']),
```

- [ ] **Step 2: Rewrite `templates/pgas-new/standalone/src/repl/index.ts.tmpl`**

Replace the entire file content with:

```typescript
import readline from 'node:readline';
import { intro, log, outro, spinner } from '@clack/prompts';
import { connectNotifications, createPgasClient, fetchTransport } from '@simodelne/pgas-server/client.js';
import type { NormalizedWidget, ReplState } from './renderer.js';
import { renderAction, renderError, renderModeChange, renderWidget } from './renderer.js';

const API_BASE = process.env.PGAS_API_BASE ?? 'http://localhost:3000';
const WS_BASE =
  process.env.PGAS_WS_BASE ?? API_BASE.replace(/^https/, 'wss').replace(/^http/, 'ws');
const TOKEN = process.env.PGAS_CLI_TOKEN ?? 'dev-token';
const DEV_MODE = process.env.PGAS_DEV_MODE !== '0';
const PROGRAM = '{{SLUG}}';

if (!DEV_MODE && TOKEN === 'dev-token') {
  process.stderr.write('PGAS_CLI_TOKEN must be set when PGAS_DEV_MODE=0\n');
  process.exit(1);
}

const client = createPgasClient(fetchTransport({ baseUrl: API_BASE, token: TOKEN }));

const state: ReplState = { sessionId: null, mode: null, running: false, awaitingInput: false };

intro('{{NAME}} — PGAS REPL');

try {
  await client.programs.list();
} catch {
  log.error(`Server not reachable at ${API_BASE}. Start it first: npm run dev`);
  process.exit(1);
}
log.step(`Connected  program: ${PROGRAM}`);

const ws = connectNotifications(
  { wsBaseUrl: WS_BASE, token: TOKEN, reconnect: true },
  {
    onMessage(event) {
      if (!('type' in event)) return;
      const ev = event as { type: string; sessionId: string; data: Record<string, unknown> };
      if (ev.type === 'connected') return;

      switch (ev.type) {
        case 'mode_change': {
          state.mode = String(ev.data.mode ?? '');
          renderModeChange(state.mode);
          updatePrompt();
          break;
        }
        case 'session:pending_input': {
          const widget = ev.data.normalizedWidget as NormalizedWidget | undefined;
          if (!widget) break;
          state.awaitingInput = true;
          renderWidget(widget, (channel, payload) =>
            runTrigger(ev.sessionId, channel, payload).finally(() => {
              state.awaitingInput = false;
              updatePrompt();
            }),
          ).catch((err) => renderError(String(err)));
          break;
        }
        case 'session_terminal':
          outro('Complete.');
          ws.close();
          process.exit(0);
          break;
        case 'error':
          renderError(String(ev.data.message ?? JSON.stringify(ev.data)));
          break;
      }
    },
    onReconnect({ attempt, delayMs }) {
      log.warn(`Connection lost — reconnecting (attempt ${String(attempt)}, delay ${String(delayMs)}ms)…`);
    },
  },
);

await ws.opened;

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
updatePrompt();

rl.on('line', async (line: string) => {
  const input = line.trim();
  if (!input || state.running || state.awaitingInput) return;
  if (input.startsWith('/')) {
    await handleCommand(input).catch((err) => renderError(String(err)));
  } else {
    await handleText(input).catch((err) => renderError(String(err)));
  }
  if (!state.running && !state.awaitingInput) updatePrompt();
});

rl.on('close', () => {
  ws.close();
  process.exit(0);
});

process.on('SIGINT', async () => {
  if (state.sessionId && state.running) {
    await client.sessions.abort(state.sessionId).catch(() => {});
  }
  outro('Bye.');
  ws.close();
  process.exit(0);
});

function updatePrompt(): void {
  const label = state.mode ? ` [${state.mode}]` : '';
  rl.setPrompt(`›${label} `);
  rl.prompt();
}

async function handleCommand(input: string): Promise<void> {
  const cmd = input.slice(1).split(' ')[0] ?? '';
  switch (cmd) {
    case 'help':
      log.info('/new  /abort  /status  /history  /resume  /help');
      break;
    case 'new':
      state.sessionId = null;
      state.mode = null;
      log.step('Ready — send a message to start a new session.');
      break;
    case 'abort':
      if (state.sessionId) {
        await client.sessions.abort(state.sessionId);
        log.step('Session aborted.');
        state.sessionId = null;
        state.mode = null;
      } else {
        log.warn('No active session.');
      }
      break;
    case 'status':
      log.info(
        state.sessionId
          ? `session: ${state.sessionId}  mode: ${state.mode ?? '?'}`
          : 'No active session.',
      );
      break;
    case 'history':
      log.info(`active: ${state.sessionId ?? 'none'}  mode: ${state.mode ?? '?'}`);
      break;
    case 'resume':
      log.step('Resuming…');
      break;
    default:
      log.warn(`Unknown command: /${cmd}`);
  }
}

async function handleText(userText: string): Promise<void> {
  if (!state.sessionId) {
    const created = await client.sessions.create({
      program: PROGRAM,
      domain_context: { query: userText },
    });
    state.sessionId = created.sessionId;
  }
  await runTrigger(state.sessionId!, 'user_text', userText);
}

async function runTrigger(sessionId: string, channel: string, payload: unknown): Promise<void> {
  state.running = true;
  const s = spinner();
  s.start('Thinking…');

  const STEP_LABELS: Record<string, string> = {
    ingestion: 'reading context…',
    projection: 'projecting state…',
    authorship: 'drafting response…',
    recognition: 'validating action…',
    execution: 'applying action…',
  };

  try {
    const stream = client.sessions.triggerStream(sessionId, {
      channel,
      payload,
    } as Parameters<typeof client.sessions.triggerStream>[1]);
    for await (const event of stream) {
      if (event.event === 'step') {
        const step = String((event.data as Record<string, unknown>).step ?? '');
        s.message(STEP_LABELS[step] ?? step);
      } else if (event.event === 'round_complete') {
        s.stop();
        const result = (event.data as Record<string, unknown>).result ?? event.data;
        renderAction(result as { name: string; payload?: Record<string, unknown> });
      } else if (event.event === 'error') {
        s.stop('Error.');
        renderError(String((event.data as Record<string, unknown>).message ?? event.data));
      }
    }
  } catch (err) {
    s.stop('Error.');
    renderError(String(err));
  } finally {
    state.running = false;
  }
}
```

- [ ] **Step 3: Run unit tests**

```bash
npx vitest run --config tests/vitest.config.ts tests/unit/template-renderer.test.ts 2>&1 | tail -20
```

Expected: The streaming REPL test passes. All other tests still pass.

- [ ] **Step 4: Commit**

```bash
git add templates/pgas-new/standalone/src/repl/index.ts.tmpl \
        src/pgas-new/template-renderer.ts
git commit -m "feat: rewrite index.ts.tmpl as pure SSE+WS streaming REPL client"
```

---

### Task 3: Update `package.json.tmpl` to add `@clack/prompts` and `chalk`

**Files:**
- Modify: `templates/pgas-new/standalone/package.json.tmpl`

**Interfaces:**
- No new interfaces — adds runtime deps the REPL templates already reference

- [ ] **Step 1: Update `templates/pgas-new/standalone/package.json.tmpl`**

Find the `dependencies` block:
```json
  "dependencies": {
    "@simodelne/pgas-server": "^{{PGAS_SERVER_VERSION}}"
  },
```

Replace with:
```json
  "dependencies": {
    "@simodelne/pgas-server": "^{{PGAS_SERVER_VERSION}}",
    "@clack/prompts": "^0.9.0",
    "chalk": "^5.4.1"
  },
```

- [ ] **Step 2: Run full unit test suite**

```bash
npx vitest run --config tests/vitest.config.ts 2>&1 | tail -10
```

Expected: 82 tests pass (the streaming REPL test covers the package.json assertion).

- [ ] **Step 3: Run full `npm test`**

```bash
npm test 2>&1 | tail -20
```

Expected: typecheck + manifest (21 pass) + unit (82 pass) + static (8 pass) — all green.

If the static test fails on the generated scaffold typecheck, it means `@clack/prompts` or `chalk` isn't installed in the generated scaffold during the shell test. The static shell test does `npm install` in step [6/6] which picks up the new deps automatically — no fix needed.

- [ ] **Step 4: Commit**

```bash
git add templates/pgas-new/standalone/package.json.tmpl
git commit -m "feat: add @clack/prompts and chalk to generated scaffold package.json"
```

---

### Task 4: Update static shell gate to check `renderer.ts`

**Files:**
- Modify: `tests/pgas-new-static.test.sh` — add renderer.ts check alongside index.ts check

- [ ] **Step 1: Update `tests/pgas-new-static.test.sh`**

Find lines 19-21:
```bash
test -f "$WORK/src/programs/pgas-new/specs.yml" && pass "rendered specs.yml" || fail "missing generated specs.yml"
test -f "$WORK/src/repl/index.ts" && pass "rendered REPL" || fail "missing generated REPL"
test -f "$WORK/tests/live-provider.test.ts" && pass "rendered live provider test" || fail "missing generated live provider test"
```

Replace with:
```bash
test -f "$WORK/src/programs/pgas-new/specs.yml" && pass "rendered specs.yml" || fail "missing generated specs.yml"
test -f "$WORK/src/repl/index.ts" && pass "rendered REPL index" || fail "missing generated REPL index"
test -f "$WORK/src/repl/renderer.ts" && pass "rendered REPL renderer" || fail "missing generated REPL renderer"
test -f "$WORK/tests/live-provider.test.ts" && pass "rendered live provider test" || fail "missing generated live provider test"
```

- [ ] **Step 2: Run the static test**

```bash
npm run test:static 2>&1
```

Expected: `[1/6] render standalone scaffold` now shows 4 PASS lines (specs.yml, REPL index, REPL renderer, live provider test). Total: 9 pass, 0 fail.

- [ ] **Step 3: Update manifest test version string** (only if the test hardcodes the PASS count)

The manifest test (`tests/plugin-manifest.test.sh`) doesn't check static test count — no change needed.

- [ ] **Step 4: Run full `npm test`**

```bash
npm test 2>&1 | tail -5
```

Expected output:
```
=== Result: 22 pass, 0 fail ===   ← manifest (was 21, +1 for renderer check? no — manifest.test.sh is separate)
Tests  82 passed (82)
=== Result: 9 pass, 0 fail ===    ← static (was 8, +1 for renderer.ts check)
```

Wait — `plugin-manifest.test.sh` only checks governance files, not the static render count. So it stays at 21. The `pgas-new-static.test.sh` goes from 8 to 9 (one new PASS for renderer.ts).

- [ ] **Step 5: Commit**

```bash
git add tests/pgas-new-static.test.sh
git commit -m "test: add renderer.ts check to static shell gate"
```

---

### Task 5: Final verification and release commit

**Files:**
- No new files — verification only

- [ ] **Step 1: Run full test suite**

```bash
npm test 2>&1
```

Expected:
```
> pgas-new@2.3.0 test
> npm run typecheck && npm run test:manifest && npm run test:unit && npm run test:static

typecheck: PASS
=== Result: 21 pass, 0 fail ===   ← manifest
Tests  82 passed (82)              ← unit (streaming REPL test + all others)
=== Result: 9 pass, 0 fail ===    ← static (renderer.ts check added)
```

- [ ] **Step 2: Verify generated scaffold typechecks with new deps**

The static shell test step [6/6] installs and typechecks the generated scaffold — if that passes, the generated repl/index.ts and renderer.ts typecheck cleanly with the new deps.

If step [6/6] is skipped (no `NPM_TOKEN`), verify manually:

```bash
TMPDIR=$(mktemp -d)
npm run pgas-new -- render-standalone --slug smoke --name "Smoke" --out "$TMPDIR"
cd "$TMPDIR"
npm install --no-audit --no-fund
npm run typecheck
echo TYPECHECK_PASS
```

Expected: `TYPECHECK_PASS`

- [ ] **Step 3: Verify no `{{` tokens remain in any rendered output**

```bash
TMPDIR=$(mktemp -d)
npm run pgas-new -- render-standalone --slug check --name "Check" --out "$TMPDIR"
grep -r '{{' "$TMPDIR" && echo UNRENDERED_TOKENS_FOUND || echo NO_UNRENDERED_TOKENS
```

Expected: `NO_UNRENDERED_TOKENS`

- [ ] **Step 4: Release commit with version bump to v2.4.0**

Update `package.json`, `.claude-plugin/plugin.json`, and `tests/plugin-manifest.test.sh` to version `2.4.0`:

```bash
# package.json: "version": "2.3.0" → "2.4.0"
# .claude-plugin/plugin.json: "version": "2.3.0" → "2.4.0"
# tests/plugin-manifest.test.sh: EXPECTED_VERSION="2.3.0" → "2.4.0"
```

Run `npm install --package-lock-only` to update lock file.

Run `npm test` to confirm all pass with new version.

```bash
git add package.json package-lock.json .claude-plugin/plugin.json tests/plugin-manifest.test.sh
git commit -m "release: pgas-new v2.4.0 — streaming REPL (SSE+WS+clack)"
git tag -a v2.4.0 -m "pgas-new v2.4.0 — streaming REPL with SSE+WS+@clack/prompts"
```
