import { describe, expect, test } from 'bun:test';
import {
  computeLintBaseline,
  deriveCycleAttention,
  cycleReportStateKey,
  shouldPersistCycleReport,
  type WarningHistory,
} from '../src/core/cycle/report-attention.ts';
import type { PhaseResult } from '../src/core/cycle.ts';

const phase = (
  name: PhaseResult['phase'],
  status: PhaseResult['status'],
  details: Record<string, unknown> = {},
): PhaseResult => ({ phase: name, status, duration_ms: 1, summary: `${name} summary`, details });

describe('computeLintBaseline', () => {
  test('initializes the first baseline with zero deltas', () => {
    expect(computeLintBaseline({ 'empty-section': 31, 'huge-page': 2 }, null)).toEqual({
      baseline_initialized: true,
      current: { 'empty-section': 31, 'huge-page': 2 },
      baseline: { 'empty-section': 31, 'huge-page': 2 },
      delta: { 'empty-section': 0, 'huge-page': 0 },
      total: 33,
      baseline_total: 33,
      total_delta: 0,
    });
  });

  test('reports additions and removals against the previous successful run', () => {
    expect(computeLintBaseline(
      { 'empty-section': 33, 'missing-created': 1 },
      { 'empty-section': 31, 'huge-page': 2 },
    )).toMatchObject({
      baseline_initialized: false,
      delta: { 'empty-section': 2, 'huge-page': -2, 'missing-created': 1 },
      total: 34,
      baseline_total: 33,
      total_delta: 1,
    });
  });
});

describe('deriveCycleAttention', () => {
  test('keeps lint warnings advisory even when a rule is new', () => {
    const result = deriveCycleAttention([
      phase('lint', 'warn', { rule_counts: { 'brand-new-advisory-rule': 1 } }),
    ], {});

    expect(result.attention).toBe('advisory');
    expect(result.summary.advisory).toHaveLength(1);
    expect(result.summary.needs_attention).toHaveLength(0);
  });

  test('marks update-blocking extract_facts warnings as needs_attention immediately', () => {
    const result = deriveCycleAttention([
      phase('extract_facts', 'warn', { warnings: ['FACTS_FENCE_BELOW_SENTINEL people/alice-example'] }),
    ], {});

    expect(result.attention).toBe('needs_attention');
    expect(result.summary.needs_attention[0]?.code).toBe('FACTS_FENCE_BELOW_SENTINEL');
  });

  test('keeps a generic warning transient once and escalates the same fingerprint when persistent', () => {
    const warning = phase('sync', 'warn', { reason: 'uncommitted_files', uncommitted: { modified: 2 } });
    const first = deriveCycleAttention([warning], {});
    expect(first.attention).toBe('advisory');
    expect(first.summary.transient).toHaveLength(1);

    const history: WarningHistory = Object.fromEntries(
      first.next_history.map((entry) => [entry.fingerprint, entry.consecutive_runs]),
    );
    const second = deriveCycleAttention([warning], history);
    expect(second.attention).toBe('needs_attention');
    expect(second.summary.needs_attention).toHaveLength(1);
  });

  test('does not treat different structured warning codes from one phase as persistent', () => {
    const first = deriveCycleAttention([
      phase('sync', 'warn', { warnings: [{ code: 'FIRST_WARNING', message: 'first condition' }] }),
    ], {});
    const history: WarningHistory = Object.fromEntries(
      first.next_history.map((entry) => [entry.fingerprint, entry.consecutive_runs]),
    );
    const second = deriveCycleAttention([
      phase('sync', 'warn', { warnings: [{ code: 'SECOND_WARNING', message: 'second condition' }] }),
    ], history);

    expect(second.summary.transient).toHaveLength(1);
    expect(second.summary.transient[0].code).toBe('SECOND_WARNING');
    expect(second.summary.transient[0].consecutive_runs).toBe(1);
    expect(second.summary.needs_attention).toHaveLength(0);
  });

  test('classifies expected configuration skips without raising attention', () => {
    const result = deriveCycleAttention([
      phase('synthesize', 'skipped', { reason: 'disabled' }),
    ], {});
    expect(result.attention).toBe('none');
    expect(result.summary.expected).toHaveLength(1);
  });
});

describe('shouldPersistCycleReport', () => {
  test('derives a path-safe deterministic state key from untrusted source IDs', () => {
    expect(cycleReportStateKey('../../target')).toMatch(/^[a-f0-9]{16}$/);
    expect(cycleReportStateKey('../../target')).toBe(cycleReportStateKey('../../target'));
    expect(cycleReportStateKey('../../target')).not.toBe(cycleReportStateKey('default'));
  });

  test('does not advance operational baselines for aborted or lock-stolen partial runs', () => {
    expect(shouldPersistCycleReport('partial', true, false)).toBe(false);
    expect(shouldPersistCycleReport('partial', false, true)).toBe(false);
  });

  test('persists completed partial runs while excluding failed and skipped runs', () => {
    expect(shouldPersistCycleReport('partial', false, false)).toBe(true);
    expect(shouldPersistCycleReport('failed', false, false)).toBe(false);
    expect(shouldPersistCycleReport('skipped', false, false)).toBe(false);
  });
});
