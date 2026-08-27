/**
 * The live channel — the viewer's end of `/api/events` (CG-53).
 *
 * The server watches two things and says so; this module turns that into two
 * counters every screen can read:
 *
 *   `live.indexTick` — the graph moved. Every screen is one round-trip stale.
 *   `live.diskTick`  — source files changed on disk. Only the screens showing
 *                      one of them care, and what they care about is drift.
 *
 * A counter rather than a callback list because Svelte's effects already do the
 * subscribing: a view that reads `live.indexTick` inside an `$effect` re-runs
 * when it moves, and one that does not read it is not subscribed. `liveRefresh`
 * below wraps the three lines of bookkeeping that turns "the counter moved"
 * into "call this once".
 *
 * ## Nothing polls, and nothing loops
 *
 * `EventSource` is the transport, but its own reconnect is not: left alone it
 * retries forever at a fixed interval, so a viewer left open against a stopped
 * `codegraph ui` becomes a request every three seconds until the tab is closed.
 * So each `error` closes the stream and schedules ONE reconnect on a backoff
 * that ends: after {@link MAX_ATTEMPTS} consecutive failures the connection
 * gives up and says so, and only a deliberate signal — the tab coming back to
 * the foreground, or the window regaining focus — starts it again.
 *
 * The same rule covers the server's own bad day: a `degraded` event means live
 * watching has stopped for good on that side. The client records it and shows
 * it. It must never respond by asking again on a timer — a degraded watcher is
 * exactly the case where a poll would run forever.
 */

import { untrack } from 'svelte';

/* ----------------------------------------------------------- wire shapes -- */

export interface LiveIndexRevision {
  lastIndexedAt: number | null;
  files: number;
}

export interface LiveHello {
  type: 'hello';
  index: LiveIndexRevision | null;
  watching: { source: boolean; index: boolean };
  degraded: string | null;
  heartbeatMs: number;
  at: number;
}

export interface LiveChanged {
  type: 'changed';
  files: string[];
  total: number;
  truncated: boolean;
  /** The change could not be described file by file — assume any file is affected. */
  scan: boolean;
  at: number;
}

export interface LiveIndexEvent {
  type: 'index';
  index: LiveIndexRevision;
  files: string[];
  total: number;
  truncated: boolean;
  at: number;
}

/* --------------------------------------------------------------- backoff -- */

/** Reconnect delays, in order. The last one repeats until the attempts run out. */
export const BACKOFF_MS = [1_000, 2_000, 4_000, 8_000, 15_000, 30_000];
/** Consecutive failures before the connection stops trying on its own. */
export const MAX_ATTEMPTS = 8;

/* ----------------------------------------------------------------- state -- */

let connected = $state(false);
/** Gave up reconnecting. Only a foreground/focus signal restarts it. */
let stopped = $state(false);
let degraded = $state<string | null>(null);
let watching = $state<{ source: boolean; index: boolean } | null>(null);
let indexTick = $state(0);
let diskTick = $state(0);
let lastIndex = $state<LiveIndexEvent | null>(null);
let lastChanged = $state<LiveChanged | null>(null);

let source: EventSource | null = null;
let retry: ReturnType<typeof setTimeout> | null = null;
let attempts = 0;
let started = false;

/**
 * Ticks that arrived while the tab was in the background.
 *
 * A hidden tab still gets every event — the stream does not care — but making
 * it refetch is work nobody is looking at. The counters move when it comes
 * back, and because they are counters, ten syncs in the background still cost
 * exactly one refresh.
 */
let deferredIndex = false;
let deferredDisk = false;

function hidden(): boolean {
  return typeof document !== 'undefined' && document.visibilityState === 'hidden';
}

function bumpIndex(event: LiveIndexEvent): void {
  lastIndex = event;
  if (hidden()) {
    deferredIndex = true;
    return;
  }
  indexTick += 1;
}

function bumpDisk(event: LiveChanged): void {
  lastChanged = event;
  if (hidden()) {
    deferredDisk = true;
    return;
  }
  diskTick += 1;
}

function flushDeferred(): void {
  if (deferredIndex) {
    deferredIndex = false;
    indexTick += 1;
  }
  if (deferredDisk) {
    deferredDisk = false;
    diskTick += 1;
  }
}

/* ------------------------------------------------------------ connection -- */

function open(): void {
  if (source || typeof EventSource === 'undefined') return;
  if (retry !== null) {
    clearTimeout(retry);
    retry = null;
  }
  stopped = false;

  const es = new EventSource('api/events');
  source = es;

  es.addEventListener('open', () => {
    connected = true;
  });

  es.addEventListener('hello', (event) => {
    const hello = parse<LiveHello>(event);
    if (!hello) return;
    // A hello is the only proof the stream is really working: `open` fires on
    // the response headers, and a server that answered and then died would
    // otherwise reset the backoff it should have been paying.
    attempts = 0;
    connected = true;
    watching = hello.watching;
    degraded = hello.degraded;
  });

  es.addEventListener('changed', (event) => {
    const changed = parse<LiveChanged>(event);
    if (changed) bumpDisk(changed);
  });

  es.addEventListener('index', (event) => {
    const moved = parse<LiveIndexEvent>(event);
    if (moved) bumpIndex(moved);
  });

  es.addEventListener('degraded', (event) => {
    const note = parse<{ reason: string }>(event);
    if (note) degraded = note.reason;
  });

  es.addEventListener('error', () => {
    connected = false;
    es.close();
    if (source === es) source = null;
    attempts += 1;
    if (attempts >= MAX_ATTEMPTS) {
      // Out of attempts. Nothing on a timer from here — the tab coming back to
      // the foreground is the only thing that tries again.
      stopped = true;
      return;
    }
    const delay = BACKOFF_MS[Math.min(attempts - 1, BACKOFF_MS.length - 1)] ?? 30_000;
    retry = setTimeout(open, delay);
  });
}

function parse<T>(event: Event): T | null {
  const data = (event as MessageEvent<string>).data;
  if (typeof data !== 'string') return null;
  try {
    return JSON.parse(data) as T;
  } catch {
    return null;
  }
}

/** Connect, once, for the life of the page. */
function start(): void {
  if (started || typeof window === 'undefined') return;
  started = true;

  document.addEventListener('visibilitychange', () => {
    if (hidden()) return;
    flushDeferred();
    // Back in the foreground is the deliberate signal a stopped connection
    // waits for. A tab that has been asleep for an hour reconnects when it is
    // looked at, and not before.
    if (stopped) {
      attempts = 0;
      open();
    }
  });
  window.addEventListener('focus', () => {
    if (!stopped) return;
    attempts = 0;
    open();
  });
  window.addEventListener('pagehide', () => {
    source?.close();
    source = null;
  });

  open();
}

/* ----------------------------------------------------------------- store -- */

export const live = {
  get connected(): boolean {
    return connected;
  },
  /** True once the client has stopped trying to reconnect on its own. */
  get stopped(): boolean {
    return stopped;
  },
  /** Why the SERVER stopped watching, when it has. Never a reason to poll. */
  get degraded(): string | null {
    return degraded;
  },
  get watching(): { source: boolean; index: boolean } | null {
    return watching;
  },
  get indexTick(): number {
    return indexTick;
  },
  get diskTick(): number {
    return diskTick;
  },
  get lastIndex(): LiveIndexEvent | null {
    return lastIndex;
  },
  get lastChanged(): LiveChanged | null {
    return lastChanged;
  },
  start,
};

/**
 * Whether the latest on-disk change is one a screen showing `file` should react
 * to.
 *
 * `scan: true` means the watcher could not name the files (a directory removal,
 * or a burst past its ceiling), so the honest answer is yes.
 */
export function touchesFile(file: string | null): boolean {
  const changed = lastChanged;
  if (!changed) return false;
  if (changed.scan || changed.truncated) return true;
  if (file === null) return false;
  return changed.files.includes(file);
}

/**
 * Call `refresh` when what a screen is showing has gone stale.
 *
 * Two different staleness signals, deliberately not merged:
 *
 * - **the index moved** — every screen refetches. Not "the file I am showing
 *   changed": a rail is the answer to a question about the whole graph, and a
 *   symbol gains a caller when some *other* file is edited. Filtering by the
 *   focused file here would leave the rails quietly wrong, which is the failure
 *   this whole task exists to remove. One request per sync is the cost, and a
 *   sync is not a thing that happens in a loop.
 * - **the file changed on disk** — only the screen showing that file, and only
 *   so its drift banner appears without waiting for the sync.
 *
 * Must be called during component initialisation (it creates an `$effect`).
 */
export function liveRefresh(
  file: () => string | null,
  refresh: (reason: 'index' | 'disk') => void
): void {
  let seenIndex = indexTick;
  let seenDisk = diskTick;
  $effect(() => {
    const index = live.indexTick;
    const disk = live.diskTick;
    const path = file();
    untrack(() => {
      if (index !== seenIndex) {
        seenIndex = index;
        // An index event supersedes any disk event before it: the sync that
        // just landed is what those edits became.
        seenDisk = disk;
        refresh('index');
        return;
      }
      if (disk !== seenDisk) {
        seenDisk = disk;
        if (touchesFile(path)) refresh('disk');
      }
    });
  });
}
