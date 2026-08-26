import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';

const FULL_GIT_SHA = /^[0-9a-f]{40}$/;

/** Resolve the exact source revision executing this process without inventing provenance. */
export function resolveExecutingGitCommit(
  repoRoot = resolve(import.meta.dir, '..', '..'),
): string | null {
  const injected = process.env.GBRAIN_GIT_COMMIT?.trim().toLowerCase();
  if (injected && FULL_GIT_SHA.test(injected)) return injected;

  try {
    const commit = execFileSync('git', ['rev-parse', '--verify', 'HEAD'], {
      cwd: repoRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 5_000,
    }).trim().toLowerCase();
    return FULL_GIT_SHA.test(commit) ? commit : null;
  } catch {
    return null;
  }
}
