/**
 * The trail — the path of symbols the reader walked to get here.
 *
 * Hops live in memory (they carry names and kinds, which the URL cannot),
 * and are mirrored into the `t` query param so a reload or a shared link
 * still reproduces the walk. On a cold load only the ids survive; names are
 * filled in by `resolve()` as each hop's node is fetched.
 *
 * Encoding: comma-separated tokens, each `<dir><encoded id>` where dir is
 * `s` (start) | `d` (stepped down, into a call) | `u` (stepped up, to a
 * caller). The dir char is ALWAYS present — an id may itself begin with 'd'
 * or 'u' (`union:…`), so an optional prefix would be ambiguous.
 */

export type HopDirection = 'start' | 'down' | 'up';

export interface TrailHop {
  id: string;
  /** null until the node is fetched; render `hopLabel()` rather than this. */
  name: string | null;
  kind: string | null;
  dir: HopDirection;
}

const DIR_TO_CHAR: Record<HopDirection, string> = { start: 's', down: 'd', up: 'u' };
const CHAR_TO_DIR: Record<string, HopDirection> = { s: 'start', d: 'down', u: 'up' };

/** A readable stand-in for a hop whose name has not been resolved yet. */
export function hopLabel(hop: TrailHop): string {
  if (hop.name) return hop.name;
  const body = hop.id.includes(':') ? hop.id.slice(hop.id.indexOf(':') + 1) : hop.id;
  // Path-shaped ids (`file:src/mcp/tools.ts`) read best as their basename.
  const basename = body.slice(body.lastIndexOf('/') + 1);
  return basename.length > 0 && basename.length <= 40 ? basename : `${body.slice(0, 8)}…`;
}

export function encodeTrail(hops: readonly TrailHop[]): string {
  return hops.map((h) => DIR_TO_CHAR[h.dir] + encodeURIComponent(h.id)).join(',');
}

export function decodeTrail(encoded: string | null): TrailHop[] {
  if (!encoded) return [];
  const hops: TrailHop[] = [];
  for (const token of encoded.split(',')) {
    if (token.length < 2) continue;
    const dir = CHAR_TO_DIR[token[0] as string];
    if (!dir) continue;
    let id: string;
    try {
      id = decodeURIComponent(token.slice(1));
    } catch {
      id = token.slice(1);
    }
    if (id) hops.push({ id, name: null, kind: null, dir });
  }
  return hops;
}

let hops = $state<TrailHop[]>([]);

export const trail = {
  get hops(): readonly TrailHop[] {
    return hops;
  },
  get current(): TrailHop | null {
    return hops.length > 0 ? (hops[hops.length - 1] as TrailHop) : null;
  },
  get encoded(): string {
    return encodeTrail(hops);
  },

  /**
   * Walk to `id`. Re-visiting a symbol already on the trail truncates back to
   * it rather than appending, so stepping up and back down does not grow a
   * loop — the trail is a path, not a history.
   */
  push(hop: { id: string; name?: string | null; kind?: string | null; dir?: HopDirection }): void {
    const existing = hops.findIndex((h) => h.id === hop.id);
    if (existing >= 0) {
      hops = hops.slice(0, existing + 1);
      const at = hops[existing] as TrailHop;
      if (hop.name) at.name = hop.name;
      if (hop.kind) at.kind = hop.kind;
      return;
    }
    hops = [
      ...hops,
      {
        id: hop.id,
        name: hop.name ?? null,
        kind: hop.kind ?? null,
        dir: hop.dir ?? (hops.length === 0 ? 'start' : 'down'),
      },
    ];
  },

  /** Drop every hop after `index`, making it the current one. */
  truncateTo(index: number): void {
    if (index < 0 || index >= hops.length) return;
    hops = hops.slice(0, index + 1);
  },

  /** Fill in the name/kind of a hop once its node has been fetched. */
  resolve(id: string, info: { name?: string | null; kind?: string | null }): void {
    const hop = hops.find((h) => h.id === id);
    if (!hop) return;
    if (info.name) hop.name = info.name;
    if (info.kind) hop.kind = info.kind;
  },

  clear(): void {
    hops = [];
  },

  /** Adopt the hops encoded in a URL (cold load / back navigation). */
  hydrate(encoded: string | null): void {
    const decoded = decodeTrail(encoded);
    if (encodeTrail(decoded) === encodeTrail(hops)) return;
    // Keep any names already resolved for ids that survive the change.
    const known = new Map(hops.filter((h) => h.name).map((h) => [h.id, h]));
    hops = decoded.map((h) => {
      const seen = known.get(h.id);
      return seen ? { ...h, name: seen.name, kind: seen.kind } : h;
    });
  },
};
