import type { Writable } from 'node:stream';
import type { ActionResult } from './types.js';

export const REPL_CONTROL_HINT =
  '/approve  /reject  /abort  /new  /status  /history  /resume  /help  /exit';

export interface ReplRenderer {
  renderAction(result: ActionResult): void;
  renderBanner(displayName: string, version: string): void;
  renderError(message: string): void;
  renderGoodbye(sessionId: string | null, mode: string | null): void;
  renderInfo(message: string): void;
  renderModeChange(newMode: string): void;
  renderPrompt(mode: string | null): void;
  renderStep(message: string): void;
  startSpinner(initial: string): { update(message: string): void; stop(): void };
  write(line: string): void;
}

const colors = {
  bold: (value: string) => `\x1b[1m${value}\x1b[22m`,
  cyan: (value: string) => `\x1b[36m${value}\x1b[39m`,
  dim: (value: string) => `\x1b[2m${value}\x1b[22m`,
  green: (value: string) => `\x1b[32m${value}\x1b[39m`,
  red: (value: string) => `\x1b[31m${value}\x1b[39m`,
  yellow: (value: string) => `\x1b[33m${value}\x1b[39m`,
  blue: (value: string) => `\x1b[34m${value}\x1b[39m`,
  magenta: (value: string) => `\x1b[35m${value}\x1b[39m`,
};

const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
const ERASE_LINE = '\x1b[2K\r';

export function createReplRenderer(stdout: Writable, options: { tty?: boolean } = {}): ReplRenderer {
  const isTty = options.tty ?? Boolean((stdout as Writable & { isTTY?: boolean }).isTTY);

  const writeln = (line: string): void => {
    stdout.write(`${line}\n`);
  };

  const box = (title: string, lines: string[]): void => {
    const titleVisible = title.length;
    const contentWidth = Math.max(titleVisible, ...lines.map((line) => stripAnsi(line).length));
    const inner = contentWidth + 2;
    const top = `┌─ ${colors.bold(title)} ${'─'.repeat(Math.max(0, inner - titleVisible - 4))}┐`;
    writeln(colors.dim(top));
    for (const line of lines) {
      const visible = stripAnsi(line).length;
      const pad = ' '.repeat(Math.max(0, inner - visible - 2));
      writeln(`${colors.dim('│ ')}${line}${pad}${colors.dim(' │')}`);
    }
    writeln(colors.dim(`└${'─'.repeat(inner)}┘`));
  };

  return {
    renderBanner(displayName: string, version: string): void {
      const title = `${displayName.toUpperCase()}`;
      const subtitle = `PGAS REPL · program design foundry · v${version}`;
      const hint = colors.dim('type a message to start · /help for commands · /exit to quit');
      writeln('');
      writeln(`  ${colors.bold(colors.cyan(title))}  ${colors.dim('—')}  ${subtitle}`);
      writeln(`  ${hint}`);
      writeln('');
    },

    renderAction(result: ActionResult): void {
      const { name, payload = {} } = result;
      const title = name.replace(/_/g, ' ');

      if (name === '__fallback__') {
        writeln(colors.yellow('⚠  No valid action — try rephrasing or /abort.'));
        return;
      }

      const firstArray = Object.values(payload).find((value) => Array.isArray(value));
      if (Array.isArray(firstArray)) {
        const lines = (firstArray as Array<Record<string, unknown>>).map(
          (item, index) =>
            `${colors.dim(String(index + 1).padStart(2) + '.')} ${String(item.title ?? item.name ?? JSON.stringify(item))}`,
        );
        box(title, lines);
        return;
      }

      if (typeof payload.message === 'string') {
        writeln(`${colors.green('✓')} ${payload.message}`);
        return;
      }

      const entries = Object.entries(payload).filter(([, value]) => value !== null && value !== undefined && value !== '');
      if (entries.length === 0) {
        writeln(`${colors.green('✓')} ${colors.dim(title)}`);
        return;
      }
      const keyWidth = Math.max(...entries.map(([key]) => key.length));
      const lines = entries.map(
        ([key, value]) => `${colors.cyan(key.padEnd(keyWidth))}  ${truncate(String(value), 80)}`,
      );
      box(title, lines);
    },

    renderError(message: string): void {
      writeln(`${colors.red('✗')} ${message}`);
    },

    renderGoodbye(sessionId: string | null, mode: string | null): void {
      writeln('');
      const tag = sessionId ? colors.dim(` (session ${sessionId.slice(-8)}${mode ? `, mode ${mode}` : ''})`) : '';
      writeln(`  ${colors.dim('—')} ${colors.cyan('goodbye')}${tag}`);
      writeln('');
    },

    renderInfo(message: string): void {
      writeln(`${colors.blue('ℹ')} ${message}`);
    },

    renderModeChange(newMode: string): void {
      writeln(`${colors.magenta('→')} mode ${colors.bold(newMode)}`);
    },

    renderPrompt(mode: string | null): void {
      const label = mode ? `${colors.dim(`[${mode}]`)} ` : '';
      stdout.write(`${label}${colors.cyan('›')} `);
    },

    renderStep(message: string): void {
      writeln(`${colors.green('●')} ${message}`);
    },

    startSpinner(initial: string): { update(message: string): void; stop(): void } {
      let label = initial;
      let stopped = false;

      if (!isTty) {
        // Non-TTY (test driver, piped output): keep the legacy "step printed once" behavior
        // so transcript scrapers still see the labels.
        stdout.write(`${colors.cyan('⠋')} ${colors.dim(label)}\n`);
        return {
          update(message: string): void {
            label = message;
            if (!stopped) stdout.write(`${colors.cyan('⠋')} ${colors.dim(label)}\n`);
          },
          stop(): void {
            stopped = true;
          },
        };
      }

      let frame = 0;
      const render = (): void => {
        if (stopped) return;
        stdout.write(`${ERASE_LINE}${colors.cyan(SPINNER_FRAMES[frame % SPINNER_FRAMES.length] ?? '⠋')} ${colors.dim(label)}`);
        frame += 1;
      };
      render();
      const interval = setInterval(render, 80);
      return {
        update(message: string): void {
          label = message;
        },
        stop(): void {
          if (stopped) return;
          stopped = true;
          clearInterval(interval);
          stdout.write(ERASE_LINE);
        },
      };
    },

    write(line: string): void {
      writeln(line);
    },
  };
}

export function stripAnsi(value: string): string {
  return value.replace(/\x1b\[[0-9;]*m/g, '');
}

function truncate(value: string, width: number): string {
  if (value.length <= width) return value;
  return `${value.slice(0, Math.max(0, width - 1))}…`;
}
