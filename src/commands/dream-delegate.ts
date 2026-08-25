/** Serve-delegated Dream CLI routing and durable status surface. */

import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { serr } from '../core/console-prefix.ts';
import { probeLivePgliteHolder } from '../core/bootstrap/uninstall.ts';
import {
  IPC_UNAVAILABLE,
  readIpcSecret,
  requestDreamStart,
  requestDreamStatus,
  resolveSocketPath,
  type DreamStartIpcResult,
} from '../core/context/resolve-ipc.ts';
import type { DelegatedDreamOptions } from '../core/context/dream-ipc.ts';
import { DELEGATED_DREAM_TIMEOUT_MAX_SECONDS, type DreamStatusResponse } from '../core/context/dream-ipc.ts';
import { listDreamRuns, readDreamRun } from '../core/dream-run-store.ts';
import { configDir, gbrainPath } from '../core/config.ts';

/** Effective persistent PGLite dir; fresh configs omit the default path. */
export function resolveDreamDataDir(databasePath: string | undefined): string {
  return resolve(databasePath || gbrainPath('brain.pglite'));
}

/** PGLite is GBrain's implicit engine when config omits the engine key. */
export function isPgliteDreamConfig(
  cfg: { engine?: string; database_url?: string } | null | undefined,
): boolean {
  return cfg?.engine !== 'postgres' && !cfg?.database_url;
}

const BOOLEAN_FLAGS: Record<string, keyof DelegatedDreamOptions> = {
  '--dry-run': 'dryRun',
  '--pull': 'pull',
  '--once': 'once',
};
const VALUE_FLAGS = new Set(['--source', '--source-id', '--phase', '--date', '--from', '--to']);
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export type ParsedDelegatedDreamArgs =
  | { ok: true; options: Omit<DelegatedDreamOptions, 'timeoutSeconds'>; jsonMode: boolean }
  | { ok: false; refused: string };

/** Pure, default-deny classifier. Unknown and filesystem-bearing flags refuse. */
export function parseDelegatedDreamArgs(args: string[]): ParsedDelegatedDreamArgs {
  const options: Record<string, unknown> = {};
  let jsonMode = false;
  let sourceFlag: '--source' | '--source-id' | null = null;
  let sourceValue: string | null = null;
  const seenValueFlags = new Set<string>();

  for (let i = 0; i < args.length; i++) {
    const token = args[i];
    const boolField = BOOLEAN_FLAGS[token];
    if (boolField) {
      options[boolField] = true;
      continue;
    }
    if (token === '--json') {
      jsonMode = true;
      continue;
    }
    if (token === '--no-delegate') continue;
    if (!VALUE_FLAGS.has(token)) return { ok: false, refused: token };
    if (seenValueFlags.has(token)) return { ok: false, refused: `repeated flag ${token}` };
    seenValueFlags.add(token);

    const value = args[i + 1];
    if (value === undefined || value.startsWith('--')) {
      return { ok: false, refused: `${token} (missing value)` };
    }
    i++;
    if (token === '--source' || token === '--source-id') {
      if (sourceValue !== null && sourceValue !== value) {
        return { ok: false, refused: `${token} ${value} (conflicts with ${sourceFlag} ${sourceValue})` };
      }
      sourceFlag = token;
      sourceValue = value;
      options.sourceId = value;
    } else if (token === '--phase') {
      options.phase = value;
    } else {
      if (!ISO_DATE_RE.test(value)) return { ok: false, refused: `${token} ${value}` };
      options[token.slice(2)] = value;
    }
  }

  if (typeof options.from === 'string' && typeof options.to === 'string' && options.from > options.to) {
    return { ok: false, refused: `--from ${options.from} is after --to ${options.to}` };
  }
  if (options.once === true && options.phase === undefined) {
    return { ok: false, refused: '--once requires --phase <name>' };
  }
  return {
    ok: true,
    options: options as Omit<DelegatedDreamOptions, 'timeoutSeconds'>,
    jsonMode,
  };
}

async function setVerdict(code: number): Promise<void> {
  const { setCliExitVerdict } = await import('../core/cli-force-exit.ts');
  setCliExitVerdict(code);
}

/**
 * Engine-free durable status reader. `gbrain dream status [run-id]`; omitted
 * run id means the newest receipt. Returns the intended CLI exit code.
 */
export function runDreamStatus(args: string[], home = configDir()): number {
  const json = args.includes('--json');
  const runId = args.find((arg) => !arg.startsWith('--'));
  const record = runId ? readDreamRun(runId, home) : listDreamRuns(home)[0] ?? null;
  if (!record) {
    const message = runId ? `Dream run not found: ${runId}` : 'No Dream run receipts found.';
    if (json) console.log(JSON.stringify({ ok: false, error: 'unknown_run', message }));
    else console.error(message);
    return 1;
  }
  if (json) {
    const { client_token: _clientToken, ...safeRecord } = record;
    console.log(JSON.stringify(safeRecord, null, 2));
  }
  else {
    console.log(`Dream ${record.run_id}: ${record.state} (source=${record.source_id})`);
    if (record.report) console.log(`  cycle status: ${record.report.status}; duration: ${record.report.duration_ms}ms`);
    if (record.error) console.log(`  error: ${record.error}`);
  }
  return record.state === 'error' || record.state === 'interrupted' || record.report?.status === 'failed' ? 1 : 0;
}

/** Pre-connect Dream delegation ladder for a live PGLite serve. */
export async function maybeDelegateDreamToServe(dataDir: string, args: string[]): Promise<boolean> {
  if (args.includes('--no-delegate') || process.env.GBRAIN_DREAM_NO_DELEGATE === '1') return false;
  if (args.includes('--help') || args.includes('-h')) return false;
  if (args[0] === 'status' || args[0] === 'retriage') return false;
  try {
    const { resolveBrainId } = await import('../core/brain-resolver.ts');
    const { getCliOptions } = await import('../core/cli-options.ts');
    if (resolveBrainId(getCliOptions().brain) !== 'host') return false;
  } catch { /* fall through to the normal local path */ }

  const holder = probeLivePgliteHolder(dataDir);
  if (!holder?.serve) return false;
  const parsed = parseDelegatedDreamArgs(args);
  if (!parsed.ok) {
    serr(
      `[dream] a live \`gbrain serve\` (PID ${holder.pid}) holds this PGLite brain, and ` +
      `\`${parsed.refused}\` is not supported through serve-delegated Dream. ` +
      `Close the owning client to run that invocation locally, or retry with routine Dream flags.`,
    );
    await setVerdict(1);
    return true;
  }

  let sourceId = parsed.options.sourceId;
  if (!sourceId) {
    try {
      const { resolveSourceIdEngineFree } = await import('../core/source-resolver.ts');
      const resolved = resolveSourceIdEngineFree(null);
      if (resolved && resolved !== '__all__') sourceId = resolved;
    } catch { /* serve bound source wins */ }
  }

  const socket = resolveSocketPath(dataDir);
  const secret = readIpcSecret(dataDir);
  if (!existsSync(socket) || !secret) {
    serr(`[dream] live serve PID ${holder.pid} exposes no Dream IPC. Restart it on this GBrain version.`);
    await setVerdict(1);
    return true;
  }

  const options: DelegatedDreamOptions = {
    ...parsed.options,
    ...(sourceId ? { sourceId } : {}),
    timeoutSeconds: DELEGATED_DREAM_TIMEOUT_MAX_SECONDS,
  };
  const clientToken = randomUUID();
  let started = await requestDreamStart(socket, { secret, clientToken, options });
  if (started === IPC_UNAVAILABLE) {
    const still = probeLivePgliteHolder(dataDir);
    if (!still?.serve) return false;
    started = await requestDreamStart(socket, { secret, clientToken, options });
  }
  if (started === IPC_UNAVAILABLE || 'degraded' in (started as object)) {
    serr(`[dream] live serve PID ${holder.pid} is not answering compatible Dream IPC.`);
    await setVerdict(1);
    return true;
  }
  const start = started as Exclude<DreamStartIpcResult, typeof IPC_UNAVAILABLE | { degraded: string }>;
  if (!start.ok || !start.runId) {
    serr(`[dream] serve refused Dream: ${start.error ?? 'missing_run_id'}${start.runId ? ` (active run ${start.runId})` : ''}.`);
    await setVerdict(1);
    return true;
  }

  serr(`[dream] running inside live serve PID ${holder.pid} (run ${start.runId}).`);
  let failures = 0;
  for (;;) {
    await new Promise((resolve) => setTimeout(resolve, 250));
    const polled = await requestDreamStatus(socket, { secret, runId: start.runId });
    if (polled === IPC_UNAVAILABLE || 'degraded' in (polled as object)) {
      failures++;
      if (failures >= 60) {
        serr(`[dream] serve stopped answering status for run ${start.runId}; inspect with \`gbrain dream status ${start.runId}\`.`);
        await setVerdict(1);
        return true;
      }
      continue;
    }
    failures = 0;
    const status = polled as DreamStatusResponse;
    if (!status.ok) {
      serr(`[dream] status failed for run ${start.runId}: ${status.error ?? 'unknown_error'}`);
      await setVerdict(1);
      return true;
    }
    if (status.state === 'error' || status.state === 'interrupted') {
      serr(`[dream] run ${start.runId} ${status.state}: ${status.jobError ?? 'unknown error'}`);
      await setVerdict(1);
      return true;
    }
    if (status.state === 'done' && status.report) {
      if (parsed.jsonMode) console.log(JSON.stringify(status.report, null, 2));
      else {
        const { __testing } = await import('./dream.ts');
        __testing.printHuman(status.report);
      }
      if (status.report.status === 'failed') await setVerdict(1);
      return true;
    }
  }
}
