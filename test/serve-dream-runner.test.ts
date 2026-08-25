/** Serve-owned background Dream lifecycle and durable receipts. */

import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import type { CycleReport } from '../src/core/cycle.ts';
import { readDreamRun, writeDreamRun } from '../src/core/dream-run-store.ts';
import {
  __resetDelegatedDreamForTests,
  getDelegatedDreamStatus,
  shutdownDelegatedDream,
  startDelegatedDream,
} from '../src/core/serve-dream-runner.ts';

const homes: string[] = [];
const engine = { kind: 'pglite' } as BrainEngine;
const report: CycleReport = {
  schema_version: '1',
  timestamp: '2026-08-25T08:00:00.000Z',
  duration_ms: 10,
  status: 'clean',
  brain_dir: null,
  phases: [],
  totals: {
    lint_fixes: 0,
    backlinks_added: 0,
    pages_synced: 0,
    pages_extracted: 0,
    pages_embedded: 0,
    orphans_found: 0,
    transcripts_processed: 0,
    synth_pages_written: 0,
    patterns_written: 0,
    pages_emotional_weight_recomputed: 0,
    edges_resolved: 0,
    edges_ambiguous: 0,
    purged_sources_count: 0,
    purged_pages_count: 0,
    facts_consolidated: 0,
    consolidate_takes_written: 0,
    phantoms_redirected: 0,
    phantoms_ambiguous: 0,
    phantoms_skipped_drift: 0,
  },
};

function home(): string {
  const dir = mkdtempSync(join(tmpdir(), 'serve-dream-runner-'));
  homes.push(dir);
  return dir;
}

afterEach(() => {
  __resetDelegatedDreamForTests();
  for (const dir of homes.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('serve Dream runner', () => {
  test('returns immediately, executes in background, and persists the report', async () => {
    const dir = home();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const start = startDelegatedDream(
      engine,
      { sourceId: 'default', timeoutSeconds: 60 },
      'token-1',
      {
        boundSourceId: 'default',
        home: dir,
        execute: async (_engine, options) => {
          expect(options.sourceId).toBe('default');
          await gate;
          return report;
        },
      },
    );

    expect(start.ok).toBe(true);
    expect(getDelegatedDreamStatus(start.runId!, dir).state).toBe('running');
    expect(readDreamRun(start.runId!, dir)?.lease_expires_at).toBeString();
    expect(readDreamRun(start.runId!, dir)?.state).toBe('running');

    release();
    await Bun.sleep(10);

    expect(getDelegatedDreamStatus(start.runId!, dir)).toMatchObject({
      ok: true,
      state: 'done',
      report,
    });
    expect(readDreamRun(start.runId!, dir)).toMatchObject({ state: 'done', report });
  });

  test('deduplicates token retries and rejects overlapping different triggers', async () => {
    const dir = home();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const deps = { home: dir, execute: async () => { await gate; return report; } };

    const first = startDelegatedDream(engine, { sourceId: 'default', timeoutSeconds: 60 }, 'same', deps);
    const retry = startDelegatedDream(engine, { sourceId: 'default', timeoutSeconds: 60 }, 'same', deps);
    const overlap = startDelegatedDream(engine, { sourceId: 'default', timeoutSeconds: 60 }, 'other', deps);

    expect(retry).toEqual({ ok: true, protocol: 2, runId: first.runId });
    expect(overlap).toEqual({ ok: false, protocol: 2, error: 'busy', runId: first.runId });
    release();
    await Bun.sleep(10);
  });

  test('shutdown never resolves while the active executor still owns the engine', async () => {
    const dir = home();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const started = startDelegatedDream(
      engine,
      { sourceId: 'default', timeoutSeconds: 60 },
      'shutdown-token',
      { home: dir, execute: async () => { await gate; return report; } },
    );
    expect(started.ok).toBe(true);

    let settled = false;
    const shutdown = shutdownDelegatedDream(1).then(() => { settled = true; });
    await Bun.sleep(10);
    expect(settled).toBe(false);

    release();
    await shutdown;
    expect(settled).toBe(true);
  });

  test('persists thrown execution failures and can read status after singleton reset', async () => {
    const dir = home();
    const start = startDelegatedDream(
      engine,
      { sourceId: 'default', timeoutSeconds: 60 },
      'fail',
      { home: dir, execute: async () => { throw new Error('synthesis unavailable'); } },
    );
    await Bun.sleep(10);
    __resetDelegatedDreamForTests();

    expect(getDelegatedDreamStatus(start.runId!, dir)).toMatchObject({
      ok: true,
      state: 'error',
      jobError: 'synthesis unavailable',
    });
  });

  test('does not expire a live receipt from a stale same-event-loop heartbeat', () => {
    const dir = home();
    writeDreamRun({
      schema_version: 1,
      run_id: 'blocked-loop',
      client_token: 'token',
      state: 'running',
      source_id: 'default',
      owner_pid: process.pid,
      created_at: '2026-08-25T00:00:00.000Z',
      started_at: '2026-08-25T00:00:00.000Z',
      lease_expires_at: '2026-08-25T00:01:00.000Z',
      options: { sourceId: 'default', timeoutSeconds: 60 },
    }, dir);
    expect(getDelegatedDreamStatus('blocked-loop', dir)).toMatchObject({
      ok: true,
      state: 'running',
    });
  });

  test('classifies the shared DB cycle lock as busy rather than completed', async () => {
    const dir = home();
    const busyReport = { ...report, status: 'skipped', reason: 'cycle_already_running' } as CycleReport;
    const started = startDelegatedDream(
      engine,
      { sourceId: 'default', timeoutSeconds: 60 },
      'shared-lock',
      { home: dir, execute: async () => busyReport },
    );
    await Bun.sleep(10);
    expect(getDelegatedDreamStatus(started.runId!, dir)).toMatchObject({
      ok: true,
      state: 'error',
      jobError: 'cycle_already_running',
      report: busyReport,
    });
  });

  test('refuses to start when the durable receipt cannot be created', () => {
    const dir = home();
    let executed = false;
    const result = startDelegatedDream(
      engine,
      { sourceId: 'default', timeoutSeconds: 60 },
      'disk-full-start',
      {
        home: dir,
        persist: () => { throw new Error('ENOSPC'); },
        execute: async () => { executed = true; return report; },
      },
    );
    expect(result).toEqual({ ok: false, protocol: 2, error: 'receipt_persist_failed' });
    expect(executed).toBe(false);
  });

  test('a terminal receipt write failure cannot reject the detached task', async () => {
    const dir = home();
    let writes = 0;
    const result = startDelegatedDream(
      engine,
      { sourceId: 'default', timeoutSeconds: 60 },
      'disk-full-final',
      {
        home: dir,
        persist: (record, target) => {
          writes++;
          if (writes >= 3) throw new Error('ENOSPC');
          writeDreamRun(record, target);
        },
        execute: async () => report,
      },
    );
    expect(result.ok).toBe(true);
    await Bun.sleep(10);
    expect(getDelegatedDreamStatus(result.runId!, dir)).toMatchObject({ ok: true, state: 'done' });
    await expect(shutdownDelegatedDream()).resolves.toBeUndefined();
  });

  test('refuses source mismatch and smuggled fields before scheduling work', () => {
    const dir = home();
    expect(startDelegatedDream(engine, { sourceId: 'other', timeoutSeconds: 60 }, 'mismatch', {
      boundSourceId: 'default', home: dir, execute: async () => report,
    })).toEqual({ ok: false, protocol: 2, error: 'source_mismatch' });
    expect(startDelegatedDream(engine, { dir: '/tmp/evil', timeoutSeconds: 60 }, 'smuggle', {
      home: dir, execute: async () => report,
    })).toEqual({ ok: false, protocol: 2, error: 'invalid_options:dir' });
  });
});
