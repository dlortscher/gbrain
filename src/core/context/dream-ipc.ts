/**
 * Serve-delegated Dream IPC wire contract.
 *
 * The live serve owns PGLite, so a concurrent Dream CLI delegates the exact
 * routine cycle options to that process. This leaf module contains only wire
 * types and fail-closed validation; no engine or socket dependencies.
 */

import { ALL_PHASES, type CyclePhase, type CycleReport } from '../cycle.ts';
import { isValidSourceId } from '../source-id.ts';

export const DELEGATED_DREAM_OPTION_FIELDS = {
  sourceId: 'string',
  dryRun: 'boolean',
  pull: 'boolean',
  phase: 'string',
  date: 'string',
  from: 'string',
  to: 'string',
  once: 'boolean',
  timeoutSeconds: 'number',
} as const;

/** Eight hours: bounded after a client disappears, long enough for synthesis. */
export const DELEGATED_DREAM_TIMEOUT_MAX_SECONDS = 8 * 60 * 60;
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export interface DelegatedDreamOptions {
  sourceId?: string;
  dryRun?: boolean;
  pull?: boolean;
  phase?: CyclePhase;
  date?: string;
  from?: string;
  to?: string;
  once?: boolean;
  timeoutSeconds: number;
}

export type DelegatedDreamValidation =
  | { ok: true; options: DelegatedDreamOptions }
  | { ok: false; error: string };

export function validateDelegatedDreamOptions(raw: unknown): DelegatedDreamValidation {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { ok: false, error: 'invalid_options:options' };
  }
  const rec = raw as Record<string, unknown>;
  for (const key of Object.keys(rec)) {
    if (!(key in DELEGATED_DREAM_OPTION_FIELDS)) {
      return { ok: false, error: `invalid_options:${key}` };
    }
  }
  const out: Record<string, unknown> = {};
  for (const [key, type] of Object.entries(DELEGATED_DREAM_OPTION_FIELDS)) {
    const value = rec[key];
    if (value === undefined) continue;
    if (typeof value !== type) return { ok: false, error: `invalid_options:${key}` };
    out[key] = value;
  }
  const timeout = out.timeoutSeconds;
  if (typeof timeout !== 'number' || !Number.isInteger(timeout) || timeout <= 0) {
    return { ok: false, error: 'invalid_options:timeoutSeconds' };
  }
  out.timeoutSeconds = Math.min(timeout, DELEGATED_DREAM_TIMEOUT_MAX_SECONDS);
  if (out.sourceId !== undefined && !isValidSourceId(out.sourceId as string)) {
    return { ok: false, error: 'invalid_options:sourceId' };
  }
  if (out.phase !== undefined && !(ALL_PHASES as string[]).includes(out.phase as string)) {
    return { ok: false, error: 'invalid_options:phase' };
  }
  for (const field of ['date', 'from', 'to'] as const) {
    const value = out[field];
    if (value !== undefined && !ISO_DATE_RE.test(value as string)) {
      return { ok: false, error: `invalid_options:${field}` };
    }
  }
  if (typeof out.from === 'string' && typeof out.to === 'string' && out.from > out.to) {
    return { ok: false, error: 'invalid_options:range' };
  }
  if (out.once === true && out.phase === undefined) {
    return { ok: false, error: 'invalid_options:once' };
  }
  return { ok: true, options: out as unknown as DelegatedDreamOptions };
}

export type DelegatedDreamState = 'queued' | 'running' | 'done' | 'error' | 'interrupted';

export interface DreamStartRequest {
  kind: 'dream_start';
  protocol: 2;
  secret: string;
  clientToken: string;
  options: DelegatedDreamOptions;
}

export interface DreamStartResponse {
  ok: boolean;
  protocol: 2;
  runId?: string;
  completed?: boolean;
  error?: string;
}

export interface DreamStatusRequest {
  kind: 'dream_status';
  protocol: 2;
  secret: string;
  runId: string;
}

export interface DreamStatusResponse {
  ok: boolean;
  protocol: 2;
  state?: DelegatedDreamState;
  sourceId?: string;
  startedAt?: number;
  finishedAt?: number;
  elapsedMs?: number;
  report?: CycleReport;
  jobError?: string;
  error?: string;
}
