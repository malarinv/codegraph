/**
 * Score-proportional byte allocation for codegraph_explore (CG-12 / #1500).
 *
 * `allocateExploreBudget` decides, before anything renders, how many chars of
 * source each ranked file may spend. Its contract is what stops the explore
 * envelope from following FILE SIZE — which is the bug #1500 reported: a small
 * weakly-relevant file shipped whole while the file that actually answered the
 * question was clipped at a flat per-file cap.
 *
 * These pin the allocator's invariants directly. End-to-end behaviour on the two
 * regression fixtures lives in `explore-allocation-1500.test.ts`.
 */
import { describe, it, expect } from 'vitest';
import { allocateExploreBudget, getExploreOutputBudget } from '../src/mcp/tools';
import type { ExploreAllocationCandidate } from '../src/mcp/tools';

/** A candidate with sane defaults — tests override only what they're about. */
const cand = (
  path: string,
  score: number,
  extra: Partial<ExploreAllocationCandidate> = {},
): ExploreAllocationCandidate => ({ path, score, worth: 1, spine: false, ...extra });

const TIER_FILE_COUNTS = [10, 100, 300, 1000, 4000, 10000, 20000, 60000];

describe('allocateExploreBudget — proportional split', () => {
  const budget = getExploreOutputBudget(1000); // 24,000 / 6,500 / 8 files

  it('gives the higher-scoring file the bigger share', () => {
    const { allowances } = allocateExploreBudget(
      [cand('a.ts', 40), cand('b.ts', 10)],
      budget,
      8,
    );
    expect(allowances.get('a.ts')!).toBeGreaterThan(allowances.get('b.ts')!);
  });

  it('scales the split with the score RATIO, not just the ordering', () => {
    // The heart of the fix. Under the old flat `maxCharsPerFile` both files got
    // the same cap and the split fell out of whichever happened to be small
    // enough to ship whole; here a 4x score buys materially more than a 1.1x one.
    const wide = allocateExploreBudget([cand('a.ts', 40), cand('b.ts', 10)], budget, 8).allowances;
    const narrow = allocateExploreBudget([cand('a.ts', 22), cand('b.ts', 20)], budget, 8).allowances;
    expect(wide.get('a.ts')! / wide.get('b.ts')!)
      .toBeGreaterThan(narrow.get('a.ts')! / narrow.get('b.ts')!);
  });

  it('never reserves more than the envelope', () => {
    const { allowances, pool } = allocateExploreBudget(
      [cand('a.ts', 90), cand('b.ts', 40), cand('c.ts', 30), cand('d.ts', 12)],
      budget,
      8,
    );
    const reserved = [...allowances.values()].reduce((s, n) => s + n, 0);
    expect(reserved).toBeLessThanOrEqual(pool);
    expect(pool).toBeLessThanOrEqual(budget.maxOutputChars);
  });

  it('caps any single file at the MAX_SHARE safety valve', () => {
    // The per-file cap is retired as the primary guard, but a lone dominant file
    // must still not be handed the entire response.
    const { allowances } = allocateExploreBudget([cand('god.ts', 500)], budget, 8);
    expect(allowances.get('god.ts')!).toBeLessThanOrEqual(Math.round(budget.maxOutputChars * 0.7));
  });

  it('lets the top file exceed the old flat per-file cap when it earns it', () => {
    // The regression this task exists to fix: `maxCharsPerFile` clipped the file
    // that scored 4x its peers at exactly the same 6,500 as the noise.
    const { allowances } = allocateExploreBudget(
      [cand('answer.ts', 60), cand('noise.ts', 12)],
      budget,
      8,
    );
    expect(allowances.get('answer.ts')!).toBeGreaterThan(budget.maxCharsPerFile);
  });
});

describe('allocateExploreBudget — the relative cliff', () => {
  const budget = getExploreOutputBudget(1000);

  it('gives zero source to a file far below the top score', () => {
    const { allowances, cliffed } = allocateExploreBudget(
      [cand('answer.ts', 90), cand('incidental.ts', 3)],
      budget,
      8,
    );
    expect(cliffed).toContain('incidental.ts');
    expect(allowances.has('incidental.ts')).toBe(false);
  });

  it('is RELATIVE — the same score survives against weaker company', () => {
    const strong = allocateExploreBudget([cand('a.ts', 90), cand('b.ts', 8)], budget, 8);
    const even = allocateExploreBudget([cand('a.ts', 12), cand('b.ts', 8)], budget, 8);
    expect(strong.cliffed).toContain('b.ts');
    expect(even.cliffed).not.toContain('b.ts');
  });

  it('never rises above the score-floor ceiling, however dominant the top file', () => {
    // A 500-scoring god-file would otherwise put the cliff at 75 and silence
    // every peer the score floor had just deliberately admitted.
    const { cliffed } = allocateExploreBudget(
      [cand('god.ts', 500), cand('peer.ts', 13), cand('peer2.ts', 11)],
      budget,
      8,
    );
    expect(cliffed).toEqual([]);
  });

  it('doubles the penalty on bytes that are worth less (generated / low-value)', () => {
    // `worth` is `rankPenalty` applied a second time: generated CRUD can rank on
    // name collisions while its bytes stay boilerplate. Same score, different fate.
    const { cliffed } = allocateExploreBudget(
      [cand('answer.ts', 60), cand('gen.ts', 12, { worth: 0.3 }), cand('hand.ts', 12)],
      budget,
      8,
    );
    expect(cliffed).toContain('gen.ts');
    expect(cliffed).not.toContain('hand.ts');
  });

  it('exempts flow-spine files from the cliff', () => {
    // Clipping the spine causes the Read fallback — it IS the answer to a flow
    // question — so a spine file is never zeroed on relative score alone.
    const { allowances, cliffed } = allocateExploreBudget(
      [cand('a.ts', 400), cand('spine.ts', 2, { spine: true })],
      budget,
      8,
    );
    expect(cliffed).not.toContain('spine.ts');
    expect(allowances.get('spine.ts')!).toBeGreaterThan(0);
  });

  it('never cliffs every candidate — an empty response costs a round-trip', () => {
    const { allowances, cliffed } = allocateExploreBudget([cand('only.ts', 0.5)], budget, 8);
    expect(cliffed).toEqual([]);
    expect(allowances.get('only.ts')!).toBeGreaterThan(0);
  });

  it('hands a cliffed file\'s maxFiles slot to the next file down', () => {
    // The mechanism that got `BuildPayslip` into the #1500 response: cliffing is
    // not just "spend fewer bytes here", it frees the SLOT too.
    const { allowances } = allocateExploreBudget(
      [cand('a.ts', 90), cand('noise.ts', 2), cand('b.ts', 40)],
      budget,
      2,
    );
    expect([...allowances.keys()].sort()).toEqual(['a.ts', 'b.ts']);
  });
});

describe('allocateExploreBudget — the floor keeps diffuse questions useful', () => {
  const budget = getExploreOutputBudget(1000);

  it('gives every admitted file a slice big enough for a method', () => {
    // A survey question must still return a spread. The earlier design cliffed a
    // starved file instead of flooring it, and that CASCADED: removing the
    // smallest raised everyone else so little that the next-smallest starved too,
    // eating six legitimately-ranked peers one at a time.
    const files = [cand('a.ts', 100), cand('b.ts', 90), ...Array.from({ length: 6 }, (_, i) => cand(`p${i}.ts`, 20))];
    const { allowances } = allocateExploreBudget(files, budget, 8);
    expect(allowances.size).toBe(8);
    for (const [, chars] of allowances) expect(chars).toBeGreaterThanOrEqual(700);
  });

  it('serves fewer files well rather than many badly when the envelope cannot afford them', () => {
    const tiny = getExploreOutputBudget(10); // 13,000-char envelope
    const files = Array.from({ length: 40 }, (_, i) => cand(`f${i}.ts`, 50 - i * 0.1));
    const { allowances, cliffed } = allocateExploreBudget(files, tiny, 40);
    expect(allowances.size).toBeLessThan(40);
    expect(cliffed.length).toBeGreaterThan(0);
    for (const [, chars] of allowances) expect(chars).toBeGreaterThanOrEqual(700);
    const reserved = [...allowances.values()].reduce((s, n) => s + n, 0);
    expect(reserved).toBeLessThanOrEqual(tiny.maxOutputChars);
  });

  it('returns an empty allocation for an empty candidate list', () => {
    const { allowances, cliffed } = allocateExploreBudget([], budget, 8);
    expect(allowances.size).toBe(0);
    expect(cliffed).toEqual([]);
  });

  it('does not crash or over-allocate when every score is zero', () => {
    const { allowances } = allocateExploreBudget([cand('a.ts', 0), cand('b.ts', 0)], budget, 8);
    const reserved = [...allowances.values()].reduce((s, n) => s + n, 0);
    expect(reserved).toBeLessThanOrEqual(budget.maxOutputChars);
  });
});

describe('allocateExploreBudget — tier invariant', () => {
  it('never gives a larger tier a smaller allowance than a smaller tier', () => {
    // The standing invariant from `getExploreOutputBudget`: a bigger project must
    // never be served LESS per file. It held for the flat cap by inspection; with
    // a proportional split it has to hold for the same candidate set across every
    // tier, which is what this walks.
    const files = [cand('a.ts', 60), cand('b.ts', 30), cand('c.ts', 15)];
    let previous: Map<string, number> | null = null;
    for (const fileCount of TIER_FILE_COUNTS) {
      const { allowances } = allocateExploreBudget(files, getExploreOutputBudget(fileCount), 8);
      if (previous) {
        for (const [path, chars] of allowances) {
          expect(chars, `${path} shrank at ${fileCount} files`).toBeGreaterThanOrEqual(previous.get(path)!);
        }
      }
      previous = allowances;
    }
  });

  it('cliffs the same files at every tier — the cliff is relative, not sized', () => {
    const files = [cand('a.ts', 90), cand('noise.ts', 2)];
    const cliffs = TIER_FILE_COUNTS.map((n) =>
      allocateExploreBudget(files, getExploreOutputBudget(n), 8).cliffed.join(','));
    expect(new Set(cliffs).size).toBe(1);
  });
});
