/** Serve-delegated Dream CLI decision ladder. */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Server } from 'node:net';
import {
  maybeDelegateDreamToServe,
  runDreamStatus,
} from '../src/commands/dream-delegate.ts';
import {
  resolveSocketPath,
  startResolveIpcServer,
} from '../src/core/context/resolve-ipc.ts';
import { writeDreamRun } from '../src/core/dream-run-store.ts';
import type { CycleReport } from '../src/core/cycle.ts';
import { _resetCliExitVerdictForTests } from '../src/core/cli-force-exit.ts';

const dirs: string[] = [];
const servers: Server[] = [];
const report = {
  schema_version: '1', timestamp: '2026-08-25T08:00:00.000Z', duration_ms: 1,
  status: 'clean', brain_dir: null, phases: [],
  totals: {
    lint_fixes: 0, backlinks_added: 0, pages_synced: 0, pages_extracted: 0,
    pages_embedded: 0, orphans_found: 0, transcripts_processed: 0,
    synth_pages_written: 0, patterns_written: 0, pages_emotional_weight_recomputed: 0,
    edges_resolved: 0, edges_ambiguous: 0, purged_sources_count: 0,
    purged_pages_count: 0, facts_consolidated: 0, consolidate_takes_written: 0,
    phantoms_redirected: 0, phantoms_ambiguous: 0, phantoms_skipped_drift: 0,
  },
} satisfies CycleReport;

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'dream-delegate-'));
  dirs.push(dir);
  return dir;
}

function liveServeLock(dir: string): void {
  mkdirSync(join(dir, '.gbrain-lock'), { recursive: true });
  writeFileSync(join(dir, '.gbrain-lock', 'lock'), JSON.stringify({
    pid: process.pid,
    acquired_at: new Date().toISOString(),
    refreshed_at: new Date().toISOString(),
    command: '/x/gbrain/src/cli.ts serve',
    subcommand: 'serve',
  }));
}

beforeEach(() => {
  _resetCliExitVerdictForTests();
  process.exitCode = 0;
});

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('Dream delegation ladder', () => {
  test('falls through without a live serve and honors --no-delegate', async () => {
    const empty = tempDir();
    expect(await maybeDelegateDreamToServe(empty, ['--source', 'default'])).toBe(false);
    liveServeLock(empty);
    expect(await maybeDelegateDreamToServe(empty, ['--no-delegate'])).toBe(false);
  });

  test('refuses unsupported flags under a live serve instead of dropping them', async () => {
    const dir = tempDir();
    liveServeLock(dir);
    expect(await maybeDelegateDreamToServe(dir, ['--dir', '/tmp/other'])).toBe(true);
  });

  test('starts inside the live serve, polls, and returns its report', async () => {
    const dir = tempDir();
    liveServeLock(dir);
    writeFileSync(join(dir, '.gbrain-ipc-secret'), 'secret\n', { mode: 0o600 });
    const server = await startResolveIpcServer(resolveSocketPath(dir), {
      resolve: async () => null,
      dream_start: () => ({ ok: true, protocol: 2 as const, runId: 'run-1' }),
      dream_status: () => ({ ok: true, protocol: 2 as const, state: 'done' as const, report }),
    }, { secret: 'secret' });
    servers.push(server!);

    expect(await maybeDelegateDreamToServe(dir, ['--source', 'default', '--json'])).toBe(true);
  });
});

describe('dream status', () => {
  test('reads a durable receipt without opening the engine', () => {
    const home = tempDir();
    writeDreamRun({
      schema_version: 1,
      run_id: 'run-1',
      client_token: 'token',
      state: 'done',
      source_id: 'default',
      owner_pid: 1,
      created_at: '2026-08-25T08:00:00.000Z',
      finished_at: '2026-08-25T08:00:01.000Z',
      options: { sourceId: 'default', timeoutSeconds: 60 },
      report,
    }, home);
    expect(runDreamStatus(['run-1', '--json'], home)).toBe(0);
    expect(runDreamStatus(['missing', '--json'], home)).toBe(1);
  });
});
