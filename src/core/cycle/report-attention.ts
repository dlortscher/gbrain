import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { CycleReport, CycleStatus, PhaseResult } from '../cycle.ts';

export type CycleAttention = 'none' | 'advisory' | 'needs_attention';
export type AttentionBucket = 'expected' | 'advisory' | 'transient' | 'needs_attention';
export type WarningHistory = Record<string, number>;

export interface CycleReportState {
  lint_rule_counts: Record<string, number> | null;
  warning_history: WarningHistory;
}

export interface AttentionFinding {
  phase: PhaseResult['phase'];
  code: string;
  message: string;
  severity: 'info' | 'warning' | 'error';
  actionability: AttentionBucket;
  fingerprint: string;
  consecutive_runs: number;
}

export interface AttentionSummary {
  expected: AttentionFinding[];
  advisory: AttentionFinding[];
  transient: AttentionFinding[];
  needs_attention: AttentionFinding[];
}

export function emptyAttentionSummary(): AttentionSummary {
  return { expected: [], advisory: [], transient: [], needs_attention: [] };
}

export interface LintBaselineReport {
  baseline_initialized: boolean;
  current: Record<string, number>;
  baseline: Record<string, number>;
  delta: Record<string, number>;
  total: number;
  baseline_total: number;
  total_delta: number;
}

export function deriveStatus(phases: PhaseResult[], totals: CycleReport['totals']): CycleStatus {
  const attempted = phases.filter(
    phase => phase.details?.reason !== 'excluded_from_implicit_source_cycle',
  );
  if (attempted.length > 0) phases = attempted;
  if (phases.length === 0) return 'failed';
  const anyFailed = phases.some(phase => phase.status === 'fail');
  const allFailed = phases.every(phase => phase.status === 'fail');
  const anyWarn = phases.some(phase => phase.status === 'warn');
  if (allFailed) return 'failed';
  if (anyFailed || anyWarn) return 'partial';
  const anyWork =
    totals.lint_fixes > 0 ||
    totals.backlinks_added > 0 ||
    totals.pages_synced > 0 ||
    totals.pages_extracted > 0 ||
    totals.pages_embedded > 0 ||
    totals.pages_emotional_weight_recomputed > 0 ||
    totals.edges_resolved > 0 ||
    totals.edges_ambiguous > 0 ||
    totals.transcripts_processed > 0 ||
    totals.synth_pages_written > 0;
  return anyWork ? 'ok' : 'clean';
}

export function loadCycleReportState(path: string): CycleReportState {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<CycleReportState>;
    return {
      lint_rule_counts: parsed.lint_rule_counts && typeof parsed.lint_rule_counts === 'object'
        ? parsed.lint_rule_counts
        : null,
      warning_history: parsed.warning_history && typeof parsed.warning_history === 'object'
        ? parsed.warning_history
        : {},
    };
  } catch {
    return { lint_rule_counts: null, warning_history: {} };
  }
}

export function saveCycleReportState(path: string, state: CycleReportState): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, path);
}

const ADVISORY_SKIP_REASONS = new Set([
  'insufficient_cycle_budget',
  'deadline_hit',
]);

const BLOCKING_WARNING_CODES = [
  'FACTS_FENCE_BELOW_SENTINEL',
  'stamp_write_failed',
  'checkpoint_unavailable',
  'stall_timeout',
  'pull_failed',
  'extraction_failed',
];

function sortedCounts(counts: Record<string, number>): Record<string, number> {
  return Object.fromEntries(
    Object.entries(counts)
      .filter(([, count]) => Number.isFinite(count) && count !== 0)
      .sort(([a], [b]) => a.localeCompare(b)),
  );
}

function sumCounts(counts: Record<string, number>): number {
  return Object.values(counts).reduce((sum, count) => sum + count, 0);
}

export function computeLintBaseline(
  currentInput: Record<string, number>,
  previousInput: Record<string, number> | null,
): LintBaselineReport {
  const current = sortedCounts(currentInput);
  const baselineInitialized = previousInput === null;
  const baseline = sortedCounts(previousInput ?? current);
  const rules = [...new Set([...Object.keys(current), ...Object.keys(baseline)])].sort();
  const delta: Record<string, number> = {};
  for (const rule of rules) delta[rule] = (current[rule] ?? 0) - (baseline[rule] ?? 0);
  const total = sumCounts(current);
  const baselineTotal = sumCounts(baseline);
  return {
    baseline_initialized: baselineInitialized,
    current,
    baseline,
    delta,
    total,
    baseline_total: baselineTotal,
    total_delta: total - baselineTotal,
  };
}

function detailReason(phase: PhaseResult): string {
  const reason = phase.details?.reason;
  return typeof reason === 'string' ? reason : '';
}

interface WarningSignal { code?: string; message: string }

function warningSignals(phase: PhaseResult): WarningSignal[] {
  if (phase.status === 'fail') {
    return [{ code: phase.error?.code, message: phase.error?.message ?? phase.summary }];
  }
  const warnings = phase.details?.warnings;
  if (Array.isArray(warnings) && warnings.length > 0) {
    return warnings.map((warning) => {
      if (typeof warning === 'string') return { message: warning };
      if (warning && typeof warning === 'object') {
        const row = warning as Record<string, unknown>;
        return {
          ...(typeof row.code === 'string' ? { code: row.code } : {}),
          message: String(row.message ?? row.code ?? JSON.stringify(row)),
        };
      }
      return { message: String(warning) };
    });
  }
  return [{ message: phase.summary }];
}

function codeFor(phase: PhaseResult, signal: WarningSignal): string {
  if (phase.status === 'fail') return phase.error?.code ?? `${phase.phase.toUpperCase()}_FAILED`;
  if (signal.code) return signal.code;
  for (const code of BLOCKING_WARNING_CODES) {
    if (signal.message.includes(code) || detailReason(phase) === code) return code;
  }
  const reason = detailReason(phase);
  return reason || `${phase.phase.toUpperCase()}_${phase.status.toUpperCase()}`;
}

function fingerprintFor(phase: PhaseResult, code: string): string {
  return createHash('sha256').update(`${phase.phase}:${code}`).digest('hex').slice(0, 16);
}

function finding(
  phase: PhaseResult,
  code: string,
  message: string,
  bucket: AttentionBucket,
  consecutiveRuns: number,
): AttentionFinding {
  return {
    phase: phase.phase,
    code,
    message,
    severity: phase.status === 'fail' ? 'error' : bucket === 'expected' ? 'info' : 'warning',
    actionability: bucket,
    fingerprint: fingerprintFor(phase, code),
    consecutive_runs: consecutiveRuns,
  };
}

export function deriveCycleAttention(
  phases: PhaseResult[],
  previousHistory: WarningHistory,
): {
  attention: CycleAttention;
  summary: AttentionSummary;
  next_history: Array<{ fingerprint: string; consecutive_runs: number }>;
} {
  const summary = emptyAttentionSummary();
  const nextHistory = new Map<string, number>();

  for (const phase of phases) {
    if (phase.status === 'ok') continue;
    if (phase.status === 'skipped') {
      const reason = detailReason(phase) || 'skipped';
      const code = reason;
      // Phase-level skips normally express configuration or evidence gates and
      // are expected. Resource exhaustion is the exception: the work was
      // configured but could not run, so retain it as advisory.
      const bucket: AttentionBucket = ADVISORY_SKIP_REASONS.has(reason) ? 'advisory' : 'expected';
      summary[bucket].push(finding(phase, code, phase.summary, bucket, 1));
      continue;
    }

    for (const signal of warningSignals(phase)) {
      const code = codeFor(phase, signal);
      const fingerprint = fingerprintFor(phase, code);
      const consecutiveRuns = (previousHistory[fingerprint] ?? 0) + 1;
      nextHistory.set(fingerprint, consecutiveRuns);

      let bucket: AttentionBucket;
      if (phase.status === 'fail' || BLOCKING_WARNING_CODES.includes(code)) {
        bucket = 'needs_attention';
      } else if (phase.phase === 'lint') {
        bucket = 'advisory';
      } else if (consecutiveRuns >= 2) {
        bucket = 'needs_attention';
      } else {
        bucket = 'transient';
      }
      summary[bucket].push(finding(phase, code, signal.message, bucket, consecutiveRuns));
    }
  }

  const attention: CycleAttention = summary.needs_attention.length > 0
    ? 'needs_attention'
    : summary.advisory.length > 0 || summary.transient.length > 0
      ? 'advisory'
      : 'none';

  return {
    attention,
    summary,
    next_history: [...nextHistory].map(([fingerprint, consecutive_runs]) => ({ fingerprint, consecutive_runs })),
  };
}

export function prepareCycleReporting(opts: {
  phases: PhaseResult[];
  statePath: string;
  dryRun: boolean;
  completed: boolean;
  stampFailure?: string;
}): ReturnType<typeof deriveCycleAttention> {
  const previous = loadCycleReportState(opts.statePath);
  const lintPhase = opts.phases.find(phase => phase.phase === 'lint');
  const lintRuleCounts = lintPhase?.details?.rule_counts;
  if (lintPhase && lintRuleCounts && typeof lintRuleCounts === 'object') {
    lintPhase.details.lint_baseline = computeLintBaseline(
      lintRuleCounts as Record<string, number>,
      previous.lint_rule_counts,
    );
  }

  const result = deriveCycleAttention(opts.phases, previous.warning_history);
  if (opts.stampFailure) {
    result.attention = 'needs_attention';
    result.summary.needs_attention.push({
      phase: 'sync', code: 'stamp_write_failed', message: opts.stampFailure,
      severity: 'error', actionability: 'needs_attention',
      fingerprint: 'cycle-stamp-write-failed', consecutive_runs: 1,
    });
  }
  if (!opts.dryRun && opts.completed) {
    try {
      saveCycleReportState(opts.statePath, {
        lint_rule_counts: lintRuleCounts && typeof lintRuleCounts === 'object'
          ? lintRuleCounts as Record<string, number>
          : previous.lint_rule_counts,
        warning_history: Object.fromEntries(
          result.next_history.map(({ fingerprint, consecutive_runs }) => [fingerprint, consecutive_runs]),
        ),
      });
    } catch (error) {
      console.warn(`[cycle] failed to persist report baseline state: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return result;
}

export function shouldPersistCycleReport(
  status: CycleStatus,
  aborted: boolean,
  lockStolen: boolean,
): boolean {
  return !aborted && !lockStolen && status !== 'failed' && status !== 'skipped';
}

export function cycleReportStateKey(sourceId: string): string {
  return createHash('sha256').update(sourceId).digest('hex').slice(0, 16);
}
