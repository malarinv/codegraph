/**
 * The Steps picture in the code's order: the graph of what happens next.
 *
 * The server folds the walk into blocks and forks (`api/program.ts`); this
 * turns that into the canvas's graph — one edge per "and then", carrying the
 * condition where the code branched, and a row per step counted by how much
 * has to happen before it. What is pinned here is exactly that: the shape of
 * the picture, which is the thing a reader looks at.
 */

import { describe, it, expect } from 'vitest';
import { buildOrderModel, lineWords, orderGraph, runWords } from '../ui/src/lib/program-model';
import type { WireArm, WireBlock, WireItem, WireProgram, WireStep, WireStepsPayload } from '../ui/src/lib/wire';

/* ------------------------------------------------------------ material -- */

const step = (id: string, over: Partial<WireStep> = {}): WireStep => ({
  id,
  kind: 'effect',
  anchor: false,
  node: null,
  label: id,
  sub: 'response · handler',
  depth: 1,
  cut: null,
  ...over,
});

const arm = (when: string, body: WireBlock, over: Partial<WireArm> = {}): WireArm => ({ when, ends: null, body, ...over });

function payload(steps: WireStep[], root: WireBlock): WireStepsPayload {
  return {
    anchor: { id: 'anchor', kind: 'route', name: 'POST /login', qualifiedName: 'POST /login', file: 'r.js', line: 1, endLine: 1, language: 'javascript', test: false },
    ambiguous: [],
    project: 'api',
    steps: [step('anchor', { kind: 'anchor', anchor: true, label: 'POST /login' }), ...steps],
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

/** The graph as `from → to` lines, each with what has to hold. */
function shape(root: WireBlock): string[] {
  const g = orderGraph({ root, truncated: 0 } as WireProgram, 'anchor');
  return g.edges.map((e) => `${e.from} → ${e.to}${e.when ? ` · ${lineWords(e)}` : ''}${e.runs.length ? ` [${e.runs.join(', ')}]` : ''}`);
}

function rowsOf(root: WireBlock): Record<string, number> {
  const g = orderGraph({ root, truncated: 0 } as WireProgram, 'anchor');
  return Object.fromEntries(g.depth);
}

/* --------------------------------------------------------------- tests -- */

describe('the picture in the code’s order', () => {
  it('puts one step after the next', () => {
    expect(shape([{ kind: 'step', step: 'a' }, { kind: 'step', step: 'b' }])).toEqual(['anchor → a', 'a → b']);
    expect(rowsOf([{ kind: 'step', step: 'a' }, { kind: 'step', step: 'b' }])).toEqual({ anchor: 0, a: 1, b: 2 });
  });

  it('branches both arms off the step before the fork, and says what has to hold', () => {
    // proshop's login: look the user up, then sign+answer 200, else answer 401.
    const on = 'user && (await user.matchPassword(password))';
    const root: WireBlock = [
      { kind: 'step', step: 'findOne' },
      {
        kind: 'fork',
        form: 'if',
        on,
        arms: [
          arm(on, [{ kind: 'block', block: 'inline', body: [{ kind: 'step', step: 'sign' }] }, { kind: 'step', step: '200' }], { ends: 'reply' }),
          arm(`!(${on})`, [{ kind: 'step', step: '401' }], { not: true, ends: 'reply' }),
        ],
      },
    ];
    expect(shape(root)).toEqual([
      'anchor → findOne',
      'findOne → sign · WHEN user AND (await user.matchPassword… [via a helper]',
      'sign → 200',
      'findOne → 401 · WHEN NOT (user && (await user.matchPass…',
    ]);
    // The 200 sits a row BELOW the signing, which is the whole point.
    expect(rowsOf(root)).toEqual({ anchor: 0, findOne: 1, sign: 2, '200': 3, '401': 2 });
  });

  it('rejoins after an arm that runs on, and stops at one that ends', () => {
    const root: WireBlock = [
      { kind: 'step', step: 'lookup' },
      {
        kind: 'fork',
        form: 'if',
        on: 'ready',
        arms: [arm('ready', [{ kind: 'step', step: 'inside' }]), arm('!ready', [{ kind: 'step', step: 'bail' }], { not: true, ends: 'return' })],
      },
      { kind: 'step', step: 'after' },
    ];
    expect(shape(root)).toEqual([
      'anchor → lookup',
      'lookup → inside · WHEN ready',
      'lookup → bail · WHEN NOT ready',
      'inside → after',
    ]);
  });

  it('runs on either way past an `if` with no else', () => {
    const root: WireBlock = [
      { kind: 'step', step: 'lookup' },
      { kind: 'fork', form: 'if', on: 'verified', arms: [arm('verified', [{ kind: 'step', step: 'mail' }])] },
      { kind: 'step', step: 'reply' },
    ];
    expect(shape(root)).toEqual([
      'anchor → lookup',
      'lookup → mail · WHEN verified',
      'mail → reply',
      'lookup → reply',
    ]);
  });

  it('reads on into what a step sets in motion before the next step', () => {
    const root: WireBlock = [
      { kind: 'step', step: 'save', body: [{ kind: 'step', step: 'write' }] },
      { kind: 'step', step: 'reply' },
    ];
    expect(shape(root)).toEqual(['anchor → save', 'save → write', 'write → reply']);
  });

  it('says the run a line happens inside', () => {
    const via = { id: 'f', kind: 'function' as const, name: 'generateToken', qualifiedName: 'generateToken', file: 'a.js', line: 1, endLine: 2, language: 'javascript', test: false };
    expect(shape([{ kind: 'block', block: 'inline', via, body: [{ kind: 'step', step: 'sign' }] }])).toEqual([
      'anchor → sign [via generateToken]',
    ]);
    expect(shape([{ kind: 'block', block: 'loop', by: 'item of items', loop: 'each', body: [{ kind: 'step', step: 'save' }] }])).toEqual([
      'anchor → save [for each item of items]',
    ]);
  });

  it('carries on past a helper that answers on every path', () => {
    // express-realworld: `login()` throws on each guard and returns on one; the
    // handler's own `res.json` still follows the call.
    const root: WireBlock = [
      {
        kind: 'block',
        block: 'inline',
        body: [{ kind: 'fork', form: 'if', on: 'bad', arms: [arm('bad', [{ kind: 'step', step: '422' }], { ends: 'reply' })] }],
      },
      { kind: 'step', step: '200' },
    ];
    expect(shape(root)).toEqual(['anchor → 422 · WHEN bad [via a helper]', 'anchor → 200']);
  });

  it('lets nothing float: a step the fold could not place follows the anchor', () => {
    const g = orderGraph({ root: [{ kind: 'cut', why: 'folded' }], truncated: 1 } as WireProgram, 'anchor');
    expect(g.edges).toEqual([]);
  });

  it('settles the rows of a step reached twice rather than looping', () => {
    const root: WireBlock = [{ kind: 'step', step: 'db' }, { kind: 'step', step: 'check' }, { kind: 'step', step: 'db' }];
    expect(shape(root)).toEqual(['anchor → db', 'db → check', 'check → db']);
    expect(rowsOf(root).db).toBeGreaterThan(0);
  });

  it('names each kind of run', () => {
    const via = { id: 'f', kind: 'function' as const, name: 'gen', qualifiedName: 'gen', file: 'a.js', line: 1, endLine: 2, language: 'javascript', test: false };
    const block = (over: Partial<Extract<WireItem, { kind: 'block' }>>) => runWords({ kind: 'block', block: 'inline', body: [], ...over } as Extract<WireItem, { kind: 'block' }>);
    expect(block({ via })).toBe('via gen');
    expect(block({})).toBe('via a helper');
    expect(block({ block: 'later', by: 'then' })).toBe('later · then');
    expect(block({ block: 'loop', by: 'item of items', loop: 'each' })).toBe('for each item of items');
    expect(block({ block: 'loop', by: 'queue.length', loop: 'while' })).toBe('again while queue.length');
    expect(block({ block: 'together', by: 'Promise.all' })).toBe('together · Promise.all');
  });

  it('builds a picture the canvas can draw, and nothing when there is no body', () => {
    const model = buildOrderModel(
      payload([step('findOne'), step('200')], [{ kind: 'step', step: 'findOne' }, { kind: 'step', step: '200' }])
    );
    expect(model).not.toBeNull();
    expect([...model!.nodes.keys()].sort()).toEqual(['200', 'anchor', 'findOne']);
    expect(model!.layout.nodes).toHaveLength(3);
    // The anchor is on top: layer 0 is the bottom.
    const layer = (id: string) => model!.layout.nodes.find((n) => n.id === id)!.layer;
    expect(layer('anchor')).toBeGreaterThan(layer('findOne'));
    expect(layer('findOne')).toBeGreaterThan(layer('200'));
    expect(buildOrderModel({ ...payload([], []), program: null })).toBeNull();
  });
});
