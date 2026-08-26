/**
 * Durable, local-only Dream run records.
 *
 * Records live outside the brain repo and are replaced atomically so a crash
 * leaves either the previous complete JSON document or the next one. The DB's
 * fenced cycle lock remains the execution mutex; these files are observability
 * and idempotency receipts, not a second lock implementation.
 */

import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { configDir } from './config.ts';
import type { DelegatedDreamOptions, DelegatedDreamState } from './context/dream-ipc.ts';
import type { CycleReport } from './cycle.ts';

export interface DreamRunRecord {
  schema_version: 1;
  run_id: string;
  client_token: string;
  state: DelegatedDreamState;
  source_id: string;
  owner_pid: number;
  created_at: string;
  started_at?: string;
  /** Persisted lease refreshed by the owning serve while the cycle runs. */
  lease_expires_at?: string;
  finished_at?: string;
  options: DelegatedDreamOptions;
  report?: CycleReport;
  error?: string;
}

const SAFE_RUN_ID_RE = /^[A-Za-z0-9-]{1,128}$/;

function runsDir(home = configDir()): string {
  return join(home, 'dream-runs');
}

function runPath(runId: string, home = configDir()): string {
  if (!SAFE_RUN_ID_RE.test(runId)) throw new Error('invalid dream run id');
  return join(runsDir(home), `${runId}.json`);
}

export function writeDreamRun(record: DreamRunRecord, home = configDir()): void {
  const dir = runsDir(home);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  try { chmodSync(dir, 0o700); } catch { /* best effort on non-POSIX filesystems */ }
  const target = runPath(record.run_id, home);
  const temp = join(dir, `.${record.run_id}.${process.pid}.${randomUUID()}.tmp`);
  try {
    writeFileSync(temp, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
    renameSync(temp, target);
    try { chmodSync(target, 0o600); } catch { /* best effort */ }
  } finally {
    if (existsSync(temp)) {
      try { unlinkSync(temp); } catch { /* best effort */ }
    }
  }
}

export function readDreamRun(runId: string, home = configDir()): DreamRunRecord | null {
  try {
    const parsed = JSON.parse(readFileSync(runPath(runId, home), 'utf8')) as DreamRunRecord;
    if (parsed?.schema_version !== 1 || parsed.run_id !== runId) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function listDreamRuns(home = configDir()): DreamRunRecord[] {
  const dir = runsDir(home);
  if (!existsSync(dir)) return [];
  const records: DreamRunRecord[] = [];
  for (const name of readdirSync(dir)) {
    if (!name.endsWith('.json')) continue;
    const runId = name.slice(0, -5);
    if (!SAFE_RUN_ID_RE.test(runId)) continue;
    const record = readDreamRun(runId, home);
    if (record) records.push(record);
  }
  return records.sort((a, b) => b.created_at.localeCompare(a.created_at));
}

/**
 * Convert orphaned non-terminal receipts to an explicit interrupted state.
 * The caller supplies ownership knowledge; the PGLite serve uses identity
 * (`pid === process.pid`) rather than signalling arbitrary processes.
 */
export function reconcileInterruptedDreamRuns(
  home = configDir(),
  isOwnerAlive: (pid: number) => boolean = (pid) => pid === process.pid,
  now = new Date().toISOString(),
): number {
  let changed = 0;
  for (const record of listDreamRuns(home)) {
    if (record.state !== 'queued' && record.state !== 'running') continue;
    if (isOwnerAlive(record.owner_pid)) continue;
    writeDreamRun({
      ...record,
      state: 'interrupted',
      finished_at: now,
      error: 'owner_process_exited',
    }, home);
    changed++;
  }
  return changed;
}
