/**
 * Serve-delegated Dream wire and argv contract.
 *
 * The nightly path must preserve the exact runCycle options while refusing
 * filesystem-bearing or subcommand invocations that cannot safely cross IPC.
 */

import { describe, expect, test } from 'bun:test';
import {
  DELEGATED_DREAM_TIMEOUT_MAX_SECONDS,
  validateDelegatedDreamOptions,
} from '../../src/core/context/dream-ipc.ts';
import { isPgliteDreamConfig, parseDelegatedDreamArgs, resolveDreamDataDir } from '../../src/commands/dream-delegate.ts';
import { delegatedDreamOptionsToArgs } from '../../src/commands/dream.ts';

describe('validateDelegatedDreamOptions', () => {
  test('accepts the routine full-cycle option set', () => {
    expect(validateDelegatedDreamOptions({
      sourceId: 'default',
      dryRun: true,
      pull: true,
      phase: 'synthesize',
      date: '2026-08-25',
      from: '2026-08-01',
      to: '2026-08-25',
      once: true,
      timeoutSeconds: 3600,
    })).toEqual({ ok: true, options: {
      sourceId: 'default',
      dryRun: true,
      pull: true,
      phase: 'synthesize',
      date: '2026-08-25',
      from: '2026-08-01',
      to: '2026-08-25',
      once: true,
      timeoutSeconds: 3600,
    }});
  });

  test('rejects unknown fields and invalid phase/date/source values', () => {
    expect(validateDelegatedDreamOptions({ dir: '/tmp/brain', timeoutSeconds: 1 })).toEqual({ ok: false, error: 'invalid_options:dir' });
    expect(validateDelegatedDreamOptions({ phase: 'not-a-phase', timeoutSeconds: 1 })).toEqual({ ok: false, error: 'invalid_options:phase' });
    expect(validateDelegatedDreamOptions({ date: 'yesterday', timeoutSeconds: 1 })).toEqual({ ok: false, error: 'invalid_options:date' });
    expect(validateDelegatedDreamOptions({ sourceId: '../other', timeoutSeconds: 1 })).toEqual({ ok: false, error: 'invalid_options:sourceId' });
  });

  test('requires a bounded integer timeout and clamps it', () => {
    expect(validateDelegatedDreamOptions({})).toEqual({ ok: false, error: 'invalid_options:timeoutSeconds' });
    expect(validateDelegatedDreamOptions({ timeoutSeconds: -1 })).toEqual({ ok: false, error: 'invalid_options:timeoutSeconds' });
    expect(validateDelegatedDreamOptions({ timeoutSeconds: DELEGATED_DREAM_TIMEOUT_MAX_SECONDS + 1 })).toEqual({
      ok: true,
      options: { timeoutSeconds: DELEGATED_DREAM_TIMEOUT_MAX_SECONDS },
    });
  });
});

describe('parseDelegatedDreamArgs default-deny', () => {
  test('maps routine flags field-for-field', () => {
    expect(parseDelegatedDreamArgs([
      '--json', '--dry-run', '--pull', '--source', 'default',
      '--phase', 'synthesize', '--date', '2026-08-25', '--once',
    ])).toEqual({
      ok: true,
      jsonMode: true,
      options: {
        dryRun: true,
        pull: true,
        sourceId: 'default',
        phase: 'synthesize',
        date: '2026-08-25',
        once: true,
      },
    });
  });

  test.each([
    ['--dir'], ['--input'], ['--drain'], ['--window'],
    ['--unsafe-bypass-dream-guard'], ['retriage'], ['status'],
    ['--some-future-flag'],
  ])('refuses %s instead of silently dropping it', (token) => {
    expect(parseDelegatedDreamArgs([token])).toEqual({ ok: false, refused: token });
  });

  test('refuses conflicting source aliases and incoherent ranges', () => {
    expect(parseDelegatedDreamArgs(['--source', 'a', '--source-id', 'b'])).toEqual({ ok: false, refused: '--source-id b (conflicts with --source a)' });
    expect(parseDelegatedDreamArgs(['--from', '2026-09-01', '--to', '2026-08-01'])).toEqual({ ok: false, refused: '--from 2026-09-01 is after --to 2026-08-01' });
  });

  test('refuses repeated singleton flags instead of changing direct-CLI semantics', () => {
    for (const argv of [
      ['--phase', 'lint', '--phase', 'synthesize'],
      ['--date', '2026-08-01', '--date', '2026-08-02'],
      ['--from', '2026-08-01', '--from', '2026-08-02'],
      ['--to', '2026-08-02', '--to', '2026-08-03'],
      ['--source', 'default', '--source', 'other'],
    ]) {
      expect(parseDelegatedDreamArgs(argv)).toEqual({
        ok: false,
        refused: `repeated flag ${argv[0]}`,
      });
    }
  });
});

describe('delegated Dream execution parity', () => {
  test('reconstructs canonical runDream argv without inventing a phase list', () => {
    expect(delegatedDreamOptionsToArgs({
      sourceId: 'default',
      dryRun: true,
      pull: true,
      phase: 'patterns',
      date: '2026-08-25',
      from: '2026-08-01',
      to: '2026-08-25',
      once: true,
      timeoutSeconds: 3600,
    })).toEqual([
      '--source', 'default', '--dry-run', '--pull', '--phase', 'patterns',
      '--date', '2026-08-25', '--from', '2026-08-01', '--to', '2026-08-25', '--once',
    ]);
    expect(delegatedDreamOptionsToArgs({ timeoutSeconds: 3600 })).toEqual([]);
  });
});

describe('resolveDreamDataDir', () => {
  test('classifies omitted engine/path as default PGLite but rejects Postgres', () => {
    expect(isPgliteDreamConfig({})).toBe(true);
    expect(isPgliteDreamConfig(null)).toBe(true);
    expect(isPgliteDreamConfig({ engine: 'pglite' })).toBe(true);
    expect(isPgliteDreamConfig({ engine: 'postgres' })).toBe(false);
    expect(isPgliteDreamConfig({ database_url: 'postgres://example' })).toBe(false);
  });

  test('uses the canonical persistent PGLite path when config omits database_path', () => {
    const prior = process.env.GBRAIN_HOME;
    process.env.GBRAIN_HOME = '/tmp/dream-default-home';
    try {
      expect(resolveDreamDataDir(undefined)).toBe('/tmp/dream-default-home/.gbrain/brain.pglite');
    } finally {
      if (prior === undefined) delete process.env.GBRAIN_HOME;
      else process.env.GBRAIN_HOME = prior;
    }
  });

  test('preserves an explicit database_path', () => {
    expect(resolveDreamDataDir('/tmp/custom-brain.pglite')).toBe('/tmp/custom-brain.pglite');
  });
});
