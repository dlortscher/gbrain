/**
 * Serve-owned Dream background runner.
 *
 * The IPC handler only validates, registers, and returns a run id. The actual
 * cycle runs asynchronously inside the process that already owns PGLite.
 * runCycle's fenced DB lock is the durable mutual-exclusion authority; this
 * module adds fast single-flight/idempotency and durable status receipts.
 */

import { randomUUID } from 'node:crypto';
import type { BrainEngine } from './engine.ts';
import type { CycleReport } from './cycle.ts';
import { configDir } from './config.ts';
import {
  readDreamRun,
  reconcileInterruptedDreamRuns,
  writeDreamRun,
  type DreamRunRecord,
} from './dream-run-store.ts';
import {
  validateDelegatedDreamOptions,
  type DelegatedDreamOptions,
  type DreamStartResponse,
  type DreamStatusResponse,
} from './context/dream-ipc.ts';

export type DreamExecutor = (
  engine: BrainEngine,
  options: DelegatedDreamOptions & { signal: AbortSignal },
) => Promise<CycleReport>;

interface ActiveDream {
  record: DreamRunRecord;
  controller: AbortController;
  settled: Promise<void>;
  home: string;
}

interface StartDreamDeps {
  boundSourceId?: string;
  home?: string;
  execute?: DreamExecutor;
  persist?: (record: DreamRunRecord, home: string) => void;
}

let current: ActiveDream | null = null;
let shuttingDown = false;
let shutdownPromise: Promise<void> | null = null;
const LEASE_MS = 60_000;
const HEARTBEAT_MS = 10_000;

function leaseExpiry(): string {
  return new Date(Date.now() + LEASE_MS).toISOString();
}

function terminal(state: DreamRunRecord['state']): boolean {
  return state === 'done' || state === 'error' || state === 'interrupted';
}

function log(message: string): void {
  process.stderr.write(`[serve-dream] ${message}\n`);
}

function persistSafely(
  persist: (record: DreamRunRecord, home: string) => void,
  record: DreamRunRecord,
  home: string,
  context: string,
): boolean {
  try {
    persist(record, home);
    return true;
  } catch (error) {
    log(`${context} receipt persist failed for run=${record.run_id}: ${error instanceof Error ? error.message : String(error)}`);
    return false;
  }
}

const defaultExecute: DreamExecutor = async (engine, options) => {
  const { executeDreamCycle } = await import('../commands/dream.ts');
  return executeDreamCycle(engine, options);
};

export function startDelegatedDream(
  engine: BrainEngine,
  rawOptions: unknown,
  clientToken: string,
  deps: StartDreamDeps = {},
): DreamStartResponse {
  if (typeof clientToken !== 'string' || clientToken.length === 0 || clientToken.length > 128) {
    return { ok: false, protocol: 2, error: 'invalid_options:clientToken' };
  }
  if (current?.record.client_token === clientToken) {
    return terminal(current.record.state)
      ? { ok: true, protocol: 2, runId: current.record.run_id, completed: true }
      : { ok: true, protocol: 2, runId: current.record.run_id };
  }
  if (shuttingDown) return { ok: false, protocol: 2, error: 'shutting_down' };
  if (current && !terminal(current.record.state)) {
    return { ok: false, protocol: 2, error: 'busy', runId: current.record.run_id };
  }

  const validated = validateDelegatedDreamOptions(rawOptions);
  if (!validated.ok) return { ok: false, protocol: 2, error: validated.error };
  const options = validated.options;
  if (options.sourceId && deps.boundSourceId && options.sourceId !== deps.boundSourceId) {
    return { ok: false, protocol: 2, error: 'source_mismatch' };
  }

  const home = deps.home ?? configDir();
  const persist = deps.persist ?? writeDreamRun;
  // `current` already excludes a live run in this process. Any other queued
  // or running receipt is therefore orphaned, including a failed preflight
  // write from this same PID. Reconcile without probing or signalling PIDs.
  reconcileInterruptedDreamRuns(home, () => false);
  const sourceId = options.sourceId ?? deps.boundSourceId ?? 'default';
  const now = new Date().toISOString();
  const record: DreamRunRecord = {
    schema_version: 1,
    run_id: randomUUID(),
    client_token: clientToken,
    state: 'queued',
    source_id: sourceId,
    owner_pid: process.pid,
    created_at: now,
    lease_expires_at: leaseExpiry(),
    options: { ...options, sourceId },
  };
  if (!persistSafely(persist, record, home, 'queued')) {
    return { ok: false, protocol: 2, error: 'receipt_persist_failed' };
  }

  const controller = new AbortController();
  record.state = 'running';
  record.started_at = new Date().toISOString();
  if (!persistSafely(persist, record, home, 'running')) {
    return { ok: false, protocol: 2, error: 'receipt_persist_failed' };
  }
  const active: ActiveDream = { record, controller, settled: Promise.resolve(), home };
  current = active;

  const execute = deps.execute ?? defaultExecute;
  const timer = setTimeout(() => {
    if (!terminal(record.state)) controller.abort(new Error(`dream deadline exceeded after ${options.timeoutSeconds}s`));
  }, options.timeoutSeconds * 1000);
  timer.unref?.();
  const heartbeat = setInterval(() => {
    if (terminal(record.state)) return;
    record.lease_expires_at = leaseExpiry();
    persistSafely(persist, record, home, 'heartbeat');
  }, HEARTBEAT_MS);
  heartbeat.unref?.();

  active.settled = (async () => {
    try {
      log(`start run=${record.run_id} source=${sourceId}`);
      const report = await execute(engine, { ...record.options, signal: controller.signal });
      record.report = report;
      if (report.status === 'skipped' && report.reason === 'cycle_already_running') {
        record.error = 'cycle_already_running';
        record.state = 'error';
        log(`busy run=${record.run_id}: shared cycle lock already held`);
      } else {
        record.state = 'done';
        log(`done run=${record.run_id} status=${report.status} in=${report.duration_ms}ms`);
      }
    } catch (error) {
      record.error = error instanceof Error ? error.message : String(error);
      record.state = controller.signal.aborted ? 'interrupted' : 'error';
      log(`${record.state} run=${record.run_id}: ${record.error}`);
    } finally {
      clearTimeout(timer);
      clearInterval(heartbeat);
      record.finished_at = new Date().toISOString();
      persistSafely(persist, record, home, 'terminal');
    }
  })().catch((error) => {
    log(`detached task rejected run=${record.run_id}: ${error instanceof Error ? error.message : String(error)}`);
  });

  return { ok: true, protocol: 2, runId: record.run_id };
}

export function getDelegatedDreamStatus(runId: string, home = configDir()): DreamStatusResponse {
  const record = current?.record.run_id === runId ? current.record : readDreamRun(runId, home);
  if (!record) return { ok: false, protocol: 2, error: 'unknown_run' };
  const startedAt = record.started_at ? Date.parse(record.started_at) : Date.parse(record.created_at);
  const finishedAt = record.finished_at ? Date.parse(record.finished_at) : undefined;
  return {
    ok: true,
    protocol: 2,
    state: record.state,
    sourceId: record.source_id,
    startedAt,
    ...(finishedAt !== undefined ? { finishedAt } : {}),
    elapsedMs: (finishedAt ?? Date.now()) - startedAt,
    ...(record.report ? { report: record.report } : {}),
    ...(record.error ? { jobError: record.error } : {}),
  };
}

export function isDelegatedDreamRunning(): boolean {
  return current !== null && !terminal(current.record.state);
}

/** Upper bound for the outer graceful-teardown watchdog while Dream settles. */
export function delegatedDreamSettleMs(): number {
  if (!isDelegatedDreamRunning() || !current) return 0;
  return current.record.options.timeoutSeconds * 1_000 + 1_000;
}

/** Abort and settle before the serve disconnects its shared engine. */
export function shutdownDelegatedDream(_legacyTimeoutMs?: number): Promise<void> {
  shuttingDown = true;
  if (shutdownPromise) return shutdownPromise;
  shutdownPromise = (async () => {
    const active = current;
    if (!active || terminal(active.record.state)) return;
    active.controller.abort(new Error('serve shutting down'));
    await active.settled;
  })().catch(() => {});
  return shutdownPromise;
}

export function __resetDelegatedDreamForTests(): void {
  current = null;
  shuttingDown = false;
  shutdownPromise = null;
}
