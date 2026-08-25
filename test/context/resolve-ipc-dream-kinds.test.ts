/** Dream start/status IPC round-trip and secret gate. */

import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Server } from 'node:net';
import {
  IPC_UNAVAILABLE,
  requestDreamStart,
  requestDreamStatus,
  resolveSocketPath,
  startResolveIpcServer,
  type IpcHandlers,
} from '../../src/core/context/resolve-ipc.ts';
import type { DreamStartResponse, DreamStatusResponse } from '../../src/core/context/dream-ipc.ts';

const SECRET = 'dream-secret';
const servers: Server[] = [];
const dirs: string[] = [];

async function server(handlers: IpcHandlers): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), 'dream-ipc-'));
  dirs.push(dir);
  const sock = resolveSocketPath(dir);
  const instance = await startResolveIpcServer(sock, handlers, { secret: SECRET, boundSourceId: 'default' });
  expect(instance).not.toBeNull();
  servers.push(instance!);
  return sock;
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map((item) => new Promise<void>((resolve) => item.close(() => resolve()))));
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('Dream IPC kinds', () => {
  test('round-trips start and status through narrow handlers', async () => {
    const handlers: IpcHandlers = {
      resolve: async () => null,
      dream_start: (req) => ({ ok: true, protocol: 2, runId: `run-${req.clientToken}` }) satisfies DreamStartResponse,
      dream_status: () => ({ ok: true, protocol: 2, state: 'running', startedAt: 1, elapsedMs: 2 }) satisfies DreamStatusResponse,
    };
    const sock = await server(handlers);

    const started = await requestDreamStart(sock, {
      secret: SECRET,
      clientToken: 'abc',
      options: { sourceId: 'default', timeoutSeconds: 60 },
    });
    expect(started).not.toBe(IPC_UNAVAILABLE);
    expect(started).toMatchObject({ ok: true, protocol: 2, runId: 'run-abc' });

    const status = await requestDreamStatus(sock, { secret: SECRET, runId: 'run-abc' });
    expect(status).toMatchObject({ ok: true, protocol: 2, state: 'running' });
  });

  test('rejects a wrong secret before invoking the handler', async () => {
    let calls = 0;
    const sock = await server({
      resolve: async () => null,
      dream_start: () => { calls++; return { ok: true, protocol: 2, runId: 'bad' }; },
    });

    const result = await requestDreamStart(sock, {
      secret: 'wrong',
      clientToken: 'abc',
      options: { timeoutSeconds: 60 },
    });
    expect(result).toMatchObject({ ok: false, protocol: 2, error: 'unauthorized' });
    expect(calls).toBe(0);
  });

  test('new server without Dream handlers returns supported-protocol refusal', async () => {
    const sock = await server({ resolve: async () => null });
    const result = await requestDreamStart(sock, {
      secret: SECRET,
      clientToken: 'abc',
      options: { timeoutSeconds: 60 },
    });
    expect(result).toMatchObject({ ok: false, protocol: 2, error: 'unsupported_kind' });
  });
});
