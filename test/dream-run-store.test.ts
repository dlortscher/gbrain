/** Durable Dream run records: atomic status and crash recovery. */

import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  listDreamRuns,
  readDreamRun,
  reconcileInterruptedDreamRuns,
  writeDreamRun,
  type DreamRunRecord,
} from '../src/core/dream-run-store.ts';

const dirs: string[] = [];
function tempHome(): string {
  const dir = mkdtempSync(join(tmpdir(), 'gbrain-dream-runs-'));
  dirs.push(dir);
  return dir;
}

function record(overrides: Partial<DreamRunRecord> = {}): DreamRunRecord {
  return {
    schema_version: 1,
    run_id: 'run-1',
    client_token: 'token-1',
    state: 'running',
    source_id: 'default',
    owner_pid: 123,
    created_at: '2026-08-25T08:00:00.000Z',
    started_at: '2026-08-25T08:00:01.000Z',
    options: { sourceId: 'default', timeoutSeconds: 3600 },
    ...overrides,
  };
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('Dream run store', () => {
  test('round-trips a run atomically and lists newest first', () => {
    const home = tempHome();
    writeDreamRun(record(), home);
    writeDreamRun(record({
      run_id: 'run-2',
      client_token: 'token-2',
      created_at: '2026-08-25T09:00:00.000Z',
    }), home);

    expect(readDreamRun('run-1', home)).toEqual(record());
    expect(listDreamRuns(home).map((run) => run.run_id)).toEqual(['run-2', 'run-1']);
  });

  test('marks a running record interrupted when its owner is dead', () => {
    const home = tempHome();
    writeDreamRun(record(), home);

    const changed = reconcileInterruptedDreamRuns(home, () => false, '2026-08-25T10:00:00.000Z');

    expect(changed).toBe(1);
    expect(readDreamRun('run-1', home)).toMatchObject({
      state: 'interrupted',
      finished_at: '2026-08-25T10:00:00.000Z',
      error: 'owner_process_exited',
    });
  });

  test('does not rewrite terminal records or a live owner', () => {
    const home = tempHome();
    writeDreamRun(record(), home);
    writeDreamRun(record({ run_id: 'done', client_token: 'done-token', state: 'done' }), home);

    expect(reconcileInterruptedDreamRuns(home, (pid) => pid === 123)).toBe(0);
    expect(readDreamRun('run-1', home)?.state).toBe('running');
    expect(readDreamRun('done', home)?.state).toBe('done');
  });
});
