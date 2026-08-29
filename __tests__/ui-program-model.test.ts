/**
 * What the rail SAYS. The block tree the server sends is turned into rows of
 * boxes and words here (`ui/src/lib/program-model.ts`); this pins the words —
 * which is the part a reader actually meets.
 */

import { describe, it, expect } from 'vitest';
import { joinTokens } from '../ui/src/lib/conditions';
import { armWords, buildRailModel, endWords, groupLabel } from '../ui/src/lib/program-model';
import type { WireArm, WireBlock, WireItem, WireStep, WireStepsPayload } from '../ui/src/lib/wire';

const step = (id: string, over: Partial<WireStep> = {}): WireStep => ({
  id,
  kind: 'effect',
  anchor: false,
  node: null,
  label: id,
  sub: `response · handler`,
  depth: 1,
  cut: null,
  ...over,
});

function payload(steps: WireStep[], root: WireBlock): WireStepsPayload {
  return {
    anchor: { id: 'a', kind: 'route', name: 'POST /login', qualifiedName: 'POST /login', file: 'r.js', line: 1, endLine: 1, language: 'javascript', test: false },
    ambiguous: [],
    project: 'api',
    steps,
    links: [],
    program: { root, truncated: 0 },
    defaultView: 'order',
    depth: 8,
    limit: 120,
    through: false,
    truncated: { steps: 0, hubs: 0, chrome: 0 },
    index: { lastIndexedAt: null, edges: 0, files: 0 },
    timing: { elapsedMs: 1 },
  };
}

const arm = (when: string, over: Partial<WireArm> = {}): WireArm => ({ when, ends: null, body: [], ...over });

describe('the rail’s words', () => {
  it('says the decision once, and each arm only which side it is', () => {
    const on = 'user && (await user.matchPassword(password))';
    const fork: WireItem = {
      kind: 'fork',
      form: 'if',
      on,
      arms: [arm(on, { ends: 'reply', body: [{ kind: 'step', step: '200' }] }), arm(`!(${on})`, { not: true, ends: 'reply', body: [{ kind: 'step', step: '401' }] })],
    };
    const model = buildRailModel(payload([step('200'), step('401')], [fork]));
    expect(model).toHaveLength(1);
    const rail = model[0]!;
    if (rail.kind !== 'fork') throw new Error('expected a fork');
    expect(joinTokens(rail.words)).toBe('user AND (await user.matchPassword(password))');
    expect(rail.arms.map((a) => joinTokens(a.words))).toEqual(['WHEN', 'WHEN NOT']);
    expect(rail.arms.map((a) => a.ends)).toEqual(['answers here', 'answers here']);
  });

  it('keeps a disjunction whole rather than reading it as two ways of arriving', () => {
    // `!image || unlimitedCollection` is ONE condition, and the parentheses
    // `guardLabel` puts round it are what stop the OR from splitting it.
    const on = '(!image || unlimitedCollection)';
    const model = buildRailModel(payload([], [{ kind: 'fork', form: 'if', on, arms: [arm(on)] }]));
    const rail = model[0]!;
    if (rail.kind !== 'fork') throw new Error('expected a fork');
    expect(joinTokens(rail.words)).toBe('(!image || unlimitedCollection)');
  });

  it('gives a switch’s arms their own conditions', () => {
    const fork: WireItem = {
      kind: 'fork',
      form: 'switch',
      on: 'kind',
      arms: [arm("kind === 'a'"), arm('kind: default')],
    };
    const model = buildRailModel(payload([], [fork]));
    const rail = model[0]!;
    if (rail.kind !== 'fork') throw new Error('expected a fork');
    expect(joinTokens(rail.words)).toBe('kind');
    expect(rail.arms.map((a) => joinTokens(a.words))).toEqual(["WHEN kind === 'a'", 'WHEN kind: default']);
  });

  it('lets a try say `on error` once', () => {
    expect(armWords('try', 'on error', arm('on error'))).toEqual([]);
    const model = buildRailModel(payload([], [{ kind: 'fork', form: 'try', on: 'on error', arms: [arm('on error')] }]));
    const rail = model[0]!;
    if (rail.kind !== 'fork') throw new Error('expected a fork');
    expect(joinTokens(rail.words)).toBe('on error');
  });

  it('says how each arm leaves', () => {
    expect(endWords('reply')).toBe('answers here');
    expect(endWords('return')).toBe('returns here');
    expect(endWords('throw')).toBe('throws here');
    expect(endWords('exit')).toBe('leaves here');
  });

  it('names each kind of bracketed run', () => {
    const via = { id: 'f', kind: 'function' as const, name: 'generateToken', qualifiedName: 'generateToken', file: 'a.js', line: 1, endLine: 2, language: 'javascript', test: false };
    expect(groupLabel({ kind: 'block', block: 'inline', via, body: [] })).toBe('via generateToken');
    expect(groupLabel({ kind: 'block', block: 'inline', body: [] })).toBe('via a helper');
    expect(groupLabel({ kind: 'block', block: 'later', by: 'then', body: [] })).toBe('later · then');
    expect(groupLabel({ kind: 'block', block: 'loop', by: 'item of items', body: [] })).toBe('for each item of items');
    expect(groupLabel({ kind: 'block', block: 'together', by: 'Promise.all', body: [] })).toBe('together · Promise.all');
  });

  it('carries a box’s two lines and where the call is written', () => {
    const model = buildRailModel(
      payload([step('200', { label: '200', sub: 'response · authUser' })], [{ kind: 'step', step: '200', within: 'res.json' }])
    );
    const rail = model[0]!;
    if (rail.kind !== 'step') throw new Error('expected a step');
    expect(rail.info?.label).toBe('200');
    expect(rail.info?.sub).toBe('response · authUser');
    expect(rail.within).toBe('res.json');
  });

  it('says where the reading stopped', () => {
    const model = buildRailModel(payload([], [{ kind: 'cut', why: 'folded' }, { kind: 'cut', why: 'depth' }]));
    expect(model.map((i) => (i.kind === 'cut' ? i.text : ''))).toEqual([
      'reads back into itself — the rest is the same code again',
      'as deep as this reading goes — start at a step below to read on',
    ]);
  });

  it('is empty when there is no body to read', () => {
    expect(buildRailModel({ ...payload([], []), program: null })).toEqual([]);
  });
});
