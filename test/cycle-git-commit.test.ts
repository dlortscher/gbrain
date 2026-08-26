import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCycle } from '../src/core/cycle.ts';
import { resolveExecutingGitCommit } from '../src/core/git-commit.ts';

describe('Dream report Git provenance', () => {
  test('resolves the executing checkout commit', () => {
    expect(resolveExecutingGitCommit()).toMatch(/^[0-9a-f]{40}$/);
  });

  test('stamps the commit in the report header', async () => {
    const brainDir = mkdtempSync(join(tmpdir(), 'gbrain-cycle-git-'));
    try {
      const report = await runCycle(null, {
        brainDir,
        phases: ['lint'],
        dryRun: true,
      });
      expect(report.git_commit).toBe(resolveExecutingGitCommit());
    } finally {
      rmSync(brainDir, { recursive: true, force: true });
    }
  });
});
