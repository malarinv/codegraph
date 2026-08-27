/**
 * Walking the graph — the one place a symbol navigation is performed.
 *
 * Every step records its DIRECTION before it navigates, because the direction
 * is not recoverable afterwards. "I stepped down into a call" and "I stepped up
 * to a caller" produce the same pair of symbols; only the act distinguishes
 * them, and the Symbol view needs it twice over: the trail bar draws `→` or `←`
 * between hops, and the arrival rail tints the row you came from ("you came
 * from here") — which is the LEFT rail after stepping down, and the RIGHT rail
 * after stepping up.
 *
 * The trail is pushed first and travels in the URL, so a reload or a shared
 * link reproduces the walk rather than starting a fresh one at the same symbol.
 */

import { navigate, symbolHref } from './router.svelte';
import { encodeTrail, trail, type HopDirection } from './trail.svelte';

export interface WalkTarget {
  id: string;
  name?: string | null;
  kind?: string | null;
}

/**
 * Move to a symbol, recording how you got there.
 *
 * @param dir  'down' following a call, 'up' going to a caller, 'start' for a
 *             jump that is neither (search, a breadcrumb, a members outline).
 * @param line a line to highlight and scroll to in the destination.
 */
export function walkTo(target: WalkTarget, dir: HopDirection, line?: number): void {
  trail.push({ id: target.id, name: target.name ?? null, kind: target.kind ?? null, dir });
  const href = symbolHref(target.id, { trail: encodeTrail(trail.hops), ...(line ? { line } : {}) });
  navigate(href);
}

/**
 * Where the reader arrived from, and which rail should show it.
 *
 * A hop marked `up` means the reader stepped from a callee to this symbol, so
 * the symbol they left is one of THIS symbol's callees — the right rail. A
 * `down` hop is the mirror. A `start` hop came from nowhere on screen.
 */
export function arrivedFrom(): { id: string; rail: 'left' | 'right' } | null {
  const hops = trail.hops;
  if (hops.length < 2) return null;
  const current = hops[hops.length - 1];
  const previous = hops[hops.length - 2];
  if (!current || !previous) return null;
  if (current.dir === 'down') return { id: previous.id, rail: 'left' };
  if (current.dir === 'up') return { id: previous.id, rail: 'right' };
  return null;
}
