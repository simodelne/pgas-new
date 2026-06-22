import type { Readable, Writable } from 'node:stream';

export interface ReplOptions {
  stdin?: Readable;
  stdout?: Writable;
  baseUrl?: string;
  apiBase?: string;
  wsBase?: string;
  token?: string;
  slug?: string;
  program?: string;
  programDisplayName?: string;
  initialDomain?: Record<string, unknown>;
  nonInteractive?: boolean;
  exitOnTerminal?: boolean;
  abortSignal?: AbortSignal;
}

export interface ReplExitInfo {
  reason: 'session_terminal' | 'user_exit' | 'sigint' | 'error';
  sessionId: string | null;
  finalMode: string | null;
  exitCode: number;
}

export interface ReplState {
  sessionId: string | null;
  mode: string | null;
  running: boolean;
  abortRequested: boolean;
}

export interface ReplStreamEvent {
  event: string;
  data: unknown;
}

export interface ActionResult {
  name: string;
  channel?: string;
  payload?: Record<string, unknown>;
}

export type ReplLogger = (level: 'info' | 'warn' | 'error', message: string) => void;
