import type { Writable } from 'node:stream';
import type { ActionResult } from './types.js';

export const REPL_CONTROL_HINT =
  '/approve  /reject  /abort  /new  /status  /history  /resume  /help  /exit';

export interface ReplRenderer {
  renderAction(result: ActionResult): void;
  renderError(message: string): void;
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
};

export function createReplRenderer(stdout: Writable): ReplRenderer {
  const writeln = (line: string): void => {
    stdout.write(`${line}\n`);
  };

  const box = (title: string, lines: string[]): void => {
    const inner = Math.max(title.length + 2, ...lines.map((line) => stripAnsi(line).length)) + 2;
    const top = `┌─ ${colors.bold(title)} ${'─'.repeat(Math.max(0, inner - title.length - 4))}┐`;
    writeln(colors.dim(top));
    for (const line of lines) {
      const visible = stripAnsi(line).length;
      const pad = ' '.repeat(Math.max(0, inner - visible - 2));
      writeln(`${colors.dim('│ ')}${line}${pad}${colors.dim(' │')}`);
    }
    writeln(colors.dim(`└${'─'.repeat(inner)}┘`));
  };

  return {
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
        writeln(`${colors.green('✓ ')}${payload.message}`);
        return;
      }

      const entries = Object.entries(payload).filter(([, value]) => value !== null && value !== undefined && value !== '');
      if (entries.length === 0) return;
      const keyWidth = Math.max(...entries.map(([key]) => key.length));
      const lines = entries.map(
        ([key, value]) => `${colors.cyan(key.padEnd(keyWidth))}  ${String(value).slice(0, 80)}`,
      );
      box(title, lines);
    },

    renderError(message: string): void {
      writeln(colors.red(`✗ ${message}`));
    },

    renderInfo(message: string): void {
      writeln(`${colors.blue('ℹ ')}${message}`);
    },

    renderModeChange(newMode: string): void {
      writeln(colors.cyan(`→ ${newMode}`));
    },

    renderPrompt(mode: string | null): void {
      const label = mode ? colors.dim(` [${mode}]`) : '';
      stdout.write(`${colors.cyan('› ')}${label}${label ? ' ' : ''}`);
    },

    renderStep(message: string): void {
      writeln(`${colors.green('● ')}${message}`);
    },

    startSpinner(initial: string): { update(message: string): void; stop(): void } {
      let label = initial;
      let stopped = false;
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
    },

    write(line: string): void {
      writeln(line);
    },
  };
}

export function stripAnsi(value: string): string {
  return value.replace(/\x1b\[[0-9;]*m/g, '');
}
