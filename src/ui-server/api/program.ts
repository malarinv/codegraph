/**
 * The anchor's body as the code reads it — the Steps view's second reading.
 *
 * `steps.ts` walks FORWARD from the anchor and draws what it sets in motion,
 * a row per distance. That is the right picture for a screen, where handlers
 * fire on events and nothing orders them. It is the wrong one for a handler:
 * on proshop's login, `User.findOne`, `jwt.sign`, `200` and `401` are each one
 * step from the anchor and land side by side, when the code says *first the
 * lookup, then IF the password matches sign a token and answer 200, ELSE
 * answer 401* — and the signing happens INSIDE the reply it is part of.
 *
 * This file turns the same walk into that reading: items in source order,
 * forks where the code forks, an arm that replies or leaves ending there, and
 * a folded helper drawn in place at the call. It is a pure function of the
 * records the walk made ({@link ProgramSite}) — no graph, no source, no
 * control-flow graph. A fork exists only where a guard was READ, so a language
 * without rules, or a file that drifted since the index, yields a plain
 * sequence rather than an invented structure.
 *
 * What makes the fold possible is that a guard names the DECISION it belongs
 * to and not just its own words (`BranchGuard.branch`): the `if` and the
 * `else` of one statement carry the same branch with `negated` flipped, an
 * early exit carries the branch of the `if` that returned, and every case of a
 * switch carries the branch of the switch. Two sites are arms of one fork when
 * they agree on the branch and disagree on the arm — which a joined condition
 * string can never say.
 */

import { guardLabel, type BranchGuard } from '../../graph/branch-guards';
import type { WireNodeRef } from './wire';

// =============================================================================
// Wire shapes
// =============================================================================

/** How an arm of a fork leaves, when it does — the rail stops there. */
export type WireArmEnd = 'reply' | 'return' | 'throw' | 'exit';

export interface WireArm {
  /** This arm's own condition, in the words the rest of the view uses. */
  when: string;
  /** How it leaves: it answers the request, returns, or throws. Null = it runs on. */
  ends: WireArmEnd | null;
  body: WireBlock;
}

export type WireBlock = WireItem[];

export type WireItem =
  /**
   * A step of the picture, where the code writes it. `body` is what it does,
   * when the walk entered it; `again` says it happens here too and was read
   * above — a function is read ONCE in a rail, however many times it is called.
   */
  | { kind: 'step'; step: string; link?: string; within?: string; body?: WireBlock; again?: true }
  /** A decision: `if` / `else`, a `switch`, a ternary, a `try`, or an early exit. */
  | { kind: 'fork'; on: string; form: 'if' | 'switch' | 'ternary' | 'try'; arms: WireArm[] }
  /**
   * A run of items that is not plain sequence: a helper drawn where it is
   * called (`inline`), a body that runs for each item (`loop`), work that runs
   * after this function returns (`later`), or calls started together
   * (`together`).
   */
  | { kind: 'block'; block: 'inline' | 'loop' | 'later' | 'together'; label: string; via?: WireNodeRef; within?: string; body: WireBlock; again?: true }
  /** Where the reading stopped: a helper that calls itself, or a cap the walk hit. */
  | { kind: 'cut'; why: 'folded' | 'depth' };

export interface WireProgram {
  root: WireBlock;
  /** Items the reading could not place — a recursion or a cap it hit. */
  truncated: number;
}

// =============================================================================
// What the walk records
// =============================================================================

/** One thing that happens in one function, and where the code writes it. */
export interface ProgramSite {
  /** The step reached here, when one is. */
  step?: string;
  /** The link that step arrived on — the panel's row for this site. */
  link?: string;
  /** The helper the walk folded into here; its own sites are its body. */
  into?: string;
  /** Where the call is written: its start, and the end of its span. */
  at: { line: number; column: number; end: { line: number; column: number } };
  /** The call this one is written inside the arguments of (`res.json`). */
  within?: string;
  /** The conditions it runs under, outermost first. */
  guards: BranchGuard[];
  /** What fires it, when something binds it — a callback runs LATER. */
  trigger?: { kind: string; name: string; of?: string | null };
}

export interface ProgramInput {
  /** The sites of each function, by the function's node id. */
  sites: ReadonlyMap<string, readonly ProgramSite[]>;
  /** Where the reading starts: the anchor's root function. */
  root: string | null;
  /** A folded helper, for the words on the block it opens. */
  node(id: string): WireNodeRef | null;
  /**
   * What a step is, for the two things the reading needs to know: whether it
   * ANSWERS (a reply ends its arm), and the function to read on into when the
   * walk entered it (null for a boundary, an effect, or a step of its own
   * chapter).
   */
  step(id: string): { reply: boolean; into: string | null } | null;
}

// =============================================================================
// The fold
// =============================================================================

/** Callbacks whose argument runs after this function returns, not where it is written. */
const LATER_OF = /^(?:then|catch|finally|setTimeout|setInterval|setImmediate|queueMicrotask|requestAnimationFrame|useEffect|useLayoutEffect|addListener|addEventListener|on|once|subscribe|nextTick|process\.nextTick)$/;

/** Calls whose arguments are started TOGETHER, not one after the other. */
const TOGETHER = /^(?:Promise\.(?:all|allSettled|any|race)|asyncio\.gather|Task\.WhenAll|Task\.WhenAny)$/;

/** How deep a helper may be drawn inside a helper before the reading says so. */
const MAX_INLINE = 8;
/** Items in one reading. A rail past this is not a reading any more. */
const MAX_ITEMS = 1200;

/**
 * What the reading has already said, so it says it once: a function whose body
 * has been drawn is drawn as a bare box (or a bare `via`) everywhere else it is
 * called, marked `again`. Without this a helper called from five arms is
 * expanded five times and a picture of 87 steps becomes four thousand items.
 */
interface Reading {
  truncated: number;
  items: number;
  read: Set<string>;
}

export function buildProgram(input: ProgramInput): WireProgram | null {
  if (input.root === null) return null;
  const state: Reading = { truncated: 0, items: 0, read: new Set([input.root]) };
  const root = blockFor(input, input.root, [input.root], state);
  return root.length === 0 ? null : { root, truncated: state.truncated };
}

/** One function's body, in the code's order. */
function blockFor(input: ProgramInput, fn: string, path: readonly string[], state: Reading): WireBlock {
  const sites = [...(input.sites.get(fn) ?? [])].sort(compareSites);
  if (sites.length === 0) return [];

  const root: WireBlock = [];
  /** The forks open at the site being placed, outermost first. */
  const stack: Array<{ branch: string; fork: Extract<WireItem, { kind: 'fork' }>; armKey: string; arm: WireArm; exit?: WireArmEnd }> = [];
  const blockAt = (depth: number): WireBlock => (depth === 0 ? root : stack[depth - 1]!.arm.body);

  for (const site of sites) {
    const guards = site.guards;

    // The longest prefix of open forks the site still sits under, arm and all.
    let keep = 0;
    while (keep < stack.length && keep < guards.length && stack[keep]!.branch === guards[keep]!.branch && stack[keep]!.armKey === armKey(guards[keep]!)) {
      keep++;
    }
    // The level after it may still be the SAME decision taken the other way —
    // an `else`, another `case`, the code after an early exit. That keeps the
    // fork and opens its other arm; anything deeper is closed either way.
    if (keep < stack.length && keep < guards.length && stack[keep]!.branch === guards[keep]!.branch) {
      stack.length = keep + 1;
      const open = stack[keep]!;
      open.armKey = armKey(guards[keep]!);
      open.arm = armFor(open.fork, guards[keep]!);
      keep++;
    } else {
      stack.length = keep;
    }
    for (let i = keep; i < guards.length; i++) {
      const g = guards[i]!;
      const fork: Extract<WireItem, { kind: 'fork' }> = { kind: 'fork', on: g.text, form: formOf(g), arms: [] };
      // An early exit is a fork whose OTHER arm left before this site could
      // run: `if (!product) throw` — the throw is written first, so it is the
      // first arm, and it is empty because nothing in the picture happens there.
      if (g.form === 'guard' && g.negated) {
        fork.arms.push({ when: guardLabel([{ ...g, negated: false }]), ends: g.exit ?? 'return', body: [] });
      }
      blockAt(i).push(fork);
      stack.push({ branch: g.branch, fork, armKey: armKey(g), arm: armFor(fork, g) });
    }

    const item = itemFor(input, site, path, state);
    if (item !== null) {
      state.items++;
      place(blockAt(guards.length), item, site);
    }
  }

  // An arm that answers the request, or whose code leaves, stops there.
  seal(input, root);
  return root;
}

/** What one recorded site draws as. */
function itemFor(input: ProgramInput, site: ProgramSite, path: readonly string[], state: Reading): WireItem | null {
  if (site.into) {
    // A helper the walk folded: drawn where it is called, its own body inside.
    const via = input.node(site.into);
    const block: Extract<WireItem, { kind: 'block' }> = {
      kind: 'block',
      block: 'inline',
      label: via ? `via ${via.name}` : 'via a helper',
      ...(via ? { via } : {}),
      ...(site.within ? { within: site.within } : {}),
      body: [],
    };
    if (!open(site.into, path, state)) {
      block.again = true;
      return block;
    }
    block.body = blockFor(input, site.into, [...path, site.into], state);
    return block.body.length === 0 ? null : block;
  }
  if (!site.step) return null;
  const step = input.step(site.step);
  const item: Extract<WireItem, { kind: 'step' }> = {
    kind: 'step',
    step: site.step,
    ...(site.link ? { link: site.link } : {}),
    ...(site.within ? { within: site.within } : {}),
  };
  // A step the walk entered reads on into what it does — the same steps the
  // tree draws a row below, here under the box that reaches them.
  if (step?.into) {
    if (open(step.into, path, state)) {
      const body = blockFor(input, step.into, [...path, step.into], state);
      if (body.length > 0) item.body = body;
    } else if (input.sites.has(step.into)) item.again = true;
  }
  return item;
}

/**
 * Whether this reading may open a function's body here: not if it is already
 * open on the way in (a helper that calls itself), not if it has been read
 * somewhere else in this picture, and not past the depth or the size the
 * reading allows.
 */
function open(fn: string, path: readonly string[], state: Reading): boolean {
  if (path.includes(fn) || state.read.has(fn)) return false;
  if (path.length >= MAX_INLINE || state.items >= MAX_ITEMS) {
    state.truncated++;
    return false;
  }
  state.read.add(fn);
  return true;
}

/**
 * Put an item in its block, opening the run it belongs to: work registered to
 * run later, and calls started together, are not the sequence they are written
 * in and say so rather than pretending.
 */
function place(block: WireBlock, item: WireItem, site: ProgramSite): void {
  const run = runFor(site);
  if (run === null) {
    block.push(item);
    return;
  }
  const last = block[block.length - 1];
  if (last && last.kind === 'block' && last.block === run.block && last.label === run.label) {
    last.body.push(item);
    return;
  }
  block.push({ kind: 'block', block: run.block, label: run.label, body: [item] });
}

/** The run a site belongs to — `later · then`, `together` — or null for plain sequence. */
function runFor(site: ProgramSite): { block: 'later' | 'together'; label: string } | null {
  const fires = site.trigger;
  if (fires && fires.kind === 'callback' && LATER_OF.test(fires.name)) return { block: 'later', label: `later · ${fires.name}` };
  if (site.within && TOGETHER.test(site.within)) return { block: 'together', label: 'together' };
  return null;
}

/** An arm of a fork by its condition, reusing the one already open for it. */
function armFor(fork: Extract<WireItem, { kind: 'fork' }>, g: BranchGuard): WireArm {
  const when = guardLabel([g]);
  const found = fork.arms.find((a) => a.when === when);
  if (found) return found;
  const arm: WireArm = { when, ends: g.armExit ?? null, body: [] };
  fork.arms.push(arm);
  return arm;
}

/** `!` and the condition — the arm, not the decision: an `if` and its `else` differ here and nowhere else. */
function armKey(g: BranchGuard): string {
  return `${g.negated ? '!' : ''}${g.text}`;
}

function formOf(g: BranchGuard): 'if' | 'switch' | 'ternary' | 'try' {
  switch (g.form) {
    case 'case':
      return 'switch';
    case 'ternary':
      return 'ternary';
    case 'catch':
      return 'try';
    default:
      return 'if';
  }
}

/**
 * How each arm ends, decided after its body is known: an arm whose last item
 * answers the request ends with the reply — the strongest thing a reader can
 * be told about an endpoint's arm — and otherwise the arm keeps how its code
 * leaves, read at the site.
 */
function seal(input: ProgramInput, block: WireBlock): void {
  for (const item of block) {
    if (item.kind === 'fork') {
      for (const arm of item.arms) {
        seal(input, arm.body);
        if (repliesLast(input, arm.body)) arm.ends = 'reply';
      }
    } else if (item.kind === 'block') seal(input, item.body);
    else if (item.kind === 'step' && item.body) seal(input, item.body);
  }
}

/** Whether the last thing a block does is answer the request. */
function repliesLast(input: ProgramInput, block: WireBlock): boolean {
  const last = block[block.length - 1];
  if (!last) return false;
  if (last.kind === 'step') return input.step(last.step)?.reply === true;
  if (last.kind === 'block') return repliesLast(input, last.body);
  return false;
}

/** Source order: a call written inside another's arguments runs first; then by position. */
function compareSites(a: ProgramSite, b: ProgramSite): number {
  if (inside(a.at, b.at)) return -1;
  if (inside(b.at, a.at)) return 1;
  return a.at.line - b.at.line || a.at.column - b.at.column;
}

function inside(x: ProgramSite['at'], y: ProgramSite['at']): boolean {
  const afterStart = x.line > y.line || (x.line === y.line && x.column > y.column);
  const beforeEnd = x.line < y.end.line || (x.line === y.end.line && x.column < y.end.column);
  return afterStart && beforeEnd;
}
