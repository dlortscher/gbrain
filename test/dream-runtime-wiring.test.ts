/** Runtime wiring pins for serve-delegated Dream. */

import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = join(import.meta.dir, '..');
const read = (path: string) => readFileSync(join(root, path), 'utf8');

describe('serve-delegated Dream runtime wiring', () => {
  test('CLI handles durable status before connect and delegates PGLite Dream before connect', () => {
    const source = read('src/cli.ts');
    const status = source.indexOf("if (command === 'dream' && args[0] === 'status')");
    const delegate = source.indexOf('maybeDelegateDreamToServe');
    const dispatch = source.indexOf("const { runDream } = await import('./commands/dream.ts')");
    expect(status).toBeGreaterThan(-1);
    expect(delegate).toBeGreaterThan(status);
    expect(dispatch).toBeGreaterThan(delegate);
    expect(read('src/core/cli-flag-registry.generated.ts'))
      .toMatch(/'dream': \[[^\n]*'--no-delegate'/);
  });

  test('MCP serve registers both Dream handlers and settles Dream before disconnect', () => {
    const binding = read('src/mcp/resolve-ipc-binding.ts');
    expect(binding).toContain('dream_start:');
    expect(binding).toContain('dream_status:');

    const server = read('src/mcp/server.ts');
    expect(server).toContain('shutdownDelegatedDream');
    expect(server.indexOf('shutdownDelegatedDream')).toBeLessThan(server.indexOf('engine.disconnect?.()'));
  });

  test('command-level serve shutdown also settles Dream before disconnect', () => {
    const source = read('src/commands/serve.ts');
    const shutdown = source.slice(source.indexOf('const beginShutdown'));
    expect(shutdown).toContain('dreamRunner.shutdownDelegatedDream');
    expect(shutdown.indexOf('dreamRunner.shutdownDelegatedDream')).toBeLessThan(shutdown.indexOf('.then(() => engine.disconnect())'));
  });
});
