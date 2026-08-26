import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { operations, type OperationContext } from '../src/core/operations.ts';

let engine: PGLiteEngine;
const putPage = operations.find(o => o.name === 'put_page')!;

function ctx(): OperationContext {
  return {
    engine: engine as never,
    config: {} as never,
    logger: console as never,
    dryRun: false,
    remote: true,
    sourceId: 'default',
  };
}

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
}, 60_000);

afterAll(async () => {
  await engine.disconnect();
}, 60_000);

beforeEach(async () => {
  await resetPgliteState(engine);
}, 30_000);

describe('put_page Facts ordering', () => {
  test('hoists a complete Facts section above the timeline sentinel', async () => {
    const content = `---
type: person
title: Alice
---

# Alice

<!-- timeline -->

## Timeline

- 2026-01-01: Met.

## Facts

<!--- gbrain:facts:begin -->
| # | claim | kind | confidence | visibility | notability | valid_from | valid_until | source | context |
|---|-------|------|------------|------------|------------|------------|-------------|--------|---------|
| 1 | Prefers concise updates | preference | 1.0 | private | medium | 2026-08-26 |  | user |  |
<!--- gbrain:facts:end -->
`;

    await putPage.handler(ctx(), { slug: 'people/alice', content });
    const page = await engine.getPage('people/alice', { sourceId: 'default' });

    expect(page?.compiled_truth).toContain('## Facts');
    expect(page?.compiled_truth).toContain('Prefers concise updates');
    expect(page?.timeline).not.toContain('gbrain:facts:begin');
    expect(page?.timeline).toContain('2026-01-01: Met.');
  });
});