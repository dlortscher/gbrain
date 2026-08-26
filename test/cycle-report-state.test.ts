import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { runCycle } from '../src/core/cycle.ts';
import { withEnv } from './helpers/with-env.ts';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('cycle report attention and lint baseline integration', () => {
  test('persists the previous lint rule counts outside the brain and reports the next delta', async () => {
    const root = mkdtempSync(join(tmpdir(), 'cycle-report-state-'));
    roots.push(root);
    const brainDir = join(root, 'brain');
    const gbrainHome = join(root, 'home');
    mkdirSync(brainDir, { recursive: true });
    writeFileSync(join(brainDir, 'one.md'), '# One\n');

    await withEnv({ GBRAIN_HOME: gbrainHome }, async () => {
      const first = await runCycle(null, { brainDir, sourceId: 'default', phases: ['lint'] });
      expect(first.status).toBe('partial');
      expect(first.attention).toBe('advisory');
      expect(first.attention_summary!.advisory).toHaveLength(1);
      expect(first.phases[0].details.lint_baseline).toMatchObject({
        baseline_initialized: true,
        current: { 'no-frontmatter': 1 },
        baseline: { 'no-frontmatter': 1 },
        delta: { 'no-frontmatter': 0 },
        total_delta: 0,
      });

      writeFileSync(join(brainDir, 'two.md'), '# Two\n');
      const second = await runCycle(null, { brainDir, sourceId: 'default', phases: ['lint'] });
      expect(second.attention).toBe('advisory');
      expect(second.phases[0].details.lint_baseline).toMatchObject({
        baseline_initialized: false,
        current: { 'no-frontmatter': 2 },
        baseline: { 'no-frontmatter': 1 },
        delta: { 'no-frontmatter': 1 },
        total: 2,
        baseline_total: 1,
        total_delta: 1,
      });
    });
  });
});
