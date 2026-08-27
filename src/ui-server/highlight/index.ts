/**
 * Server-side syntax classification for the viewer's code block (CG-43).
 *
 * The viewer used to lex on the client with a hand-rolled dialect table. This
 * replaces it with real TextMate grammars, run once here, so a Go file reads as
 * Go rather than as "something with braces". Three properties keep that from
 * becoming a liability:
 *
 * * **It never fails a request.** A missing grammar, a corrupt grammar file, an
 *   ESM import that did not resolve, a slice too big to be worth tokenising —
 *   every one of them answers `engine: 'plain'` with a reason and the source
 *   still goes out. Highlighting is the part that degrades; nothing else does.
 * * **Identifiers survive whatever token boundaries the grammar chose.** Every
 *   code token is split into identifier runs before it goes on the wire, which
 *   is what lets the viewer wrap a call site as a link by *claiming a token*
 *   rather than re-tokenising the line on top of the highlighter's answer.
 * * **The classification is a class name, not a colour.** See `theme.ts` — the
 *   viewer paints from CSS custom properties, so one token stream serves light
 *   and dark and the design tokens live in exactly one place.
 *
 * ## Cost, measured
 *
 * Shiki's JavaScript regex engine (no oniguruma wasm, no native module) runs at
 * roughly 17 us/line on Go, 34 us/line on Python and 230 us/line on TypeScript,
 * whose TextMate grammar is by a wide margin the most expensive one here. A
 * 3 000-line TypeScript file is therefore ~700 ms cold, which is why
 * {@link SLICE_CACHE_LIMIT} exists: a slice is keyed by the file's content hash
 * and its line range, so every re-render — a theme flip, a resize, stepping
 * back to a symbol — is a map lookup. Phase 1 only ever asks for one symbol's
 * range (tens of lines); the whole-file view is CG-52 and tree-sitter tokens
 * from the engine's own parse replace this module entirely in CG-57.
 */

import type {
  ShikiCoreModule,
  ShikiHighlighter,
  ShikiJavaScriptEngineModule,
  ShikiThemedToken,
} from './shiki-types';
import { CLASS_ID, MONO_THEME, TOKEN_CLASSES, classOf, type TokenClassName } from './theme';
import { grammarFor } from './languages';
import { loadManifest, readGrammarChain, type GrammarManifest } from './grammars';

export { TOKEN_CLASSES } from './theme';
export { LANGUAGE_GRAMMAR, REQUIRED_GRAMMARS, grammarFor } from './languages';
export { TEXTMATE_PATH_ENV } from './grammars';

/** One token on the wire: its class id, then its text. */
export type WireToken = [number, string];

export interface HighlightResult {
  /** `shiki` when a grammar produced the classes; `plain` when nothing did. */
  engine: 'shiki' | 'plain';
  /** The TextMate grammar used, or null. */
  grammar: string | null;
  /** Class names, indexed by the first element of every {@link WireToken}. */
  classes: readonly string[];
  /** One entry per source line, in order. */
  lines: WireToken[][];
  /** Why the answer is plain, when it is. Absent on the happy path. */
  reason?: string;
}

/**
 * Lines above this are not tokenised.
 *
 * Matches `MAX_SOURCE_LINES`, so anything the source endpoint will serve, this
 * will try to highlight.
 */
export const MAX_HIGHLIGHT_LINES = 4000;

/**
 * Characters above this are not tokenised.
 *
 * The line cap alone does not bound the work: one minified bundle line can be
 * two megabytes, and a TextMate scanner walks it character by character. This
 * is the guard that keeps a single request from wedging a single-threaded
 * loopback server, and it is generous — 600 kB is far more source than any
 * screen renders.
 */
export const MAX_HIGHLIGHT_CHARS = 600_000;

/** Highlighted slices kept in memory. Most are one symbol's body. */
export const SLICE_CACHE_LIMIT = 96;

/**
 * Total cached lines, which is the bound that actually matters.
 *
 * The entry count alone does not bound memory: 96 slices of a symbol body is a
 * megabyte, 96 whole 4 000-line files is two orders of magnitude more, and this
 * process is a reader someone leaves open all day. Twenty thousand lines is
 * roughly a working set of every symbol a session visits, or a handful of whole
 * files, and the eviction is the same recency order.
 */
export const SLICE_CACHE_LINES = 20_000;

/* ----------------------------------------------------------- the runtime -- */

/**
 * tsc compiles `import()` to `require()` under `module: commonjs`, which fails
 * for an ESM-only package. Same escape hatch `src/bin/codegraph.ts` uses.
 */
const importESM = new Function('specifier', 'return import(specifier)') as (
  specifier: string
) => Promise<unknown>;

/**
 * Import an ESM-only package from this CommonJS build.
 *
 * The `new Function` route is the one that runs in production. It does NOT run
 * under Vitest, whose module runner evaluates this file without a dynamic-import
 * callback ("A dynamic import callback was not specified") — there, the
 * transformed `import()` below is the working one, and in the shipped CommonJS
 * build it is the one that cannot work. Each covers exactly the other's gap;
 * neither alone is enough, which is why both are here.
 */
async function loadEsm<T>(specifier: string): Promise<T> {
  try {
    return (await importESM(specifier)) as T;
  } catch (err) {
    if (!(err instanceof Error) || !/dynamic import callback/i.test(err.message)) throw err;
    return (await import(/* @vite-ignore */ specifier)) as T;
  }
}

interface Runtime {
  highlighter: ShikiHighlighter;
  dir: string;
  manifest: GrammarManifest;
}

let runtimePromise: Promise<Runtime | null> | null = null;
/** Why the runtime is unavailable, for the `reason` on a plain answer. */
let runtimeFailure: string | null = null;

async function getRuntime(): Promise<Runtime | null> {
  if (!runtimePromise) runtimePromise = createRuntime();
  return runtimePromise;
}

async function createRuntime(): Promise<Runtime | null> {
  const found = loadManifest();
  if (!found) {
    runtimeFailure =
      'No syntax grammars are installed with this build, so source is shown unhighlighted.';
    return null;
  }
  try {
    const core = await loadEsm<ShikiCoreModule>('@shikijs/core');
    const engineModule = await loadEsm<ShikiJavaScriptEngineModule>('@shikijs/engine-javascript');
    const highlighter = core.createHighlighterCoreSync({
      themes: [MONO_THEME],
      langs: [],
      // The JavaScript regex engine, deliberately: no oniguruma wasm and no
      // native module, so the viewer adds nothing to the install that has to
      // be compiled or fetched per platform. `forgiving` skips the handful of
      // Oniguruma-only patterns it cannot translate rather than refusing the
      // whole grammar over them.
      engine: engineModule.createJavaScriptRegexEngine({ forgiving: true, cache: new Map() }),
    });
    return { highlighter, dir: found.dir, manifest: found.manifest };
  } catch (err) {
    runtimeFailure = `Syntax highlighting is unavailable (${
      err instanceof Error ? err.message : String(err)
    }).`;
    return null;
  }
}

/** Grammar ids already handed to the highlighter, and the ones that failed. */
const loadedGrammars = new Set<string>();
const brokenGrammars = new Map<string, string>();

function ensureGrammar(runtime: Runtime, id: string): string | null {
  if (loadedGrammars.has(id)) return null;
  const broken = brokenGrammars.get(id);
  if (broken !== undefined) return broken;
  try {
    const chain = readGrammarChain(runtime.dir, runtime.manifest, id);
    if (chain.length === 0) {
      const reason = `No ${id} grammar shipped with this build, so it is shown unhighlighted.`;
      brokenGrammars.set(id, reason);
      return reason;
    }
    runtime.highlighter.loadLanguageSync(chain);
    loadedGrammars.add(id);
    return null;
  } catch (err) {
    const reason = `The ${id} grammar could not be loaded (${
      err instanceof Error ? err.message : String(err)
    }).`;
    brokenGrammars.set(id, reason);
    return reason;
  }
}

/* -------------------------------------------------------------- the cache -- */

const sliceCache = new Map<string, HighlightResult>();
let cachedLines = 0;

function cacheGet(key: string): HighlightResult | undefined {
  const hit = sliceCache.get(key);
  // Re-insert so the map's insertion order is a recency order and the first
  // key is always the coldest.
  if (hit) {
    sliceCache.delete(key);
    sliceCache.set(key, hit);
  }
  return hit;
}

function cachePut(key: string, value: HighlightResult): void {
  sliceCache.set(key, value);
  cachedLines += value.lines.length;
  while (
    sliceCache.size > SLICE_CACHE_LIMIT ||
    (cachedLines > SLICE_CACHE_LINES && sliceCache.size > 1)
  ) {
    const oldest = sliceCache.keys().next();
    if (oldest.done) break;
    cachedLines -= sliceCache.get(oldest.value)?.lines.length ?? 0;
    sliceCache.delete(oldest.value);
  }
}

/** Drop everything cached. Tests use it; nothing in the server needs to. */
export function clearHighlightCache(): void {
  sliceCache.clear();
  cachedLines = 0;
}

/** What the slice cache is holding — for tests, and for anyone diagnosing it. */
export function highlightCacheStats(): { entries: number; lines: number } {
  return { entries: sliceCache.size, lines: cachedLines };
}

/* ------------------------------------------------------------- the entry -- */

export interface HighlightOptions {
  /** The engine's language for the file, e.g. `typescript`. */
  language?: string | null;
  /**
   * A key that changes whenever the text does — the file's content hash plus
   * the requested range. Omit it and the slice is tokenised every time.
   */
  cacheKey?: string;
}

/**
 * Classify `lines` for the viewer's code block.
 *
 * Never throws and never rejects: every failure path returns a plain result
 * carrying the reason, because the caller is serving source and the source is
 * the part that matters.
 */
export async function highlightLines(
  lines: readonly string[],
  options: HighlightOptions = {}
): Promise<HighlightResult> {
  const grammar = grammarFor(options.language);
  const key = options.cacheKey ? `${grammar ?? '-'} ${options.cacheKey}` : null;
  if (key) {
    const hit = cacheGet(key);
    if (hit) return hit;
  }

  const result = await highlightUncached(lines, grammar);
  if (key) cachePut(key, result);
  return result;
}

async function highlightUncached(
  lines: readonly string[],
  grammar: string | null
): Promise<HighlightResult> {
  if (!grammar) {
    return plain(lines, null, 'No syntax grammar covers this file type.');
  }
  if (lines.length > MAX_HIGHLIGHT_LINES) {
    return plain(lines, grammar, `Too many lines to highlight (over ${MAX_HIGHLIGHT_LINES}).`);
  }
  let chars = 0;
  for (const line of lines) chars += line.length + 1;
  if (chars > MAX_HIGHLIGHT_CHARS) {
    return plain(lines, grammar, 'Too much text on too few lines to highlight (minified?).');
  }

  const runtime = await getRuntime();
  if (!runtime) return plain(lines, grammar, runtimeFailure ?? undefined);

  const failure = ensureGrammar(runtime, grammar);
  if (failure) return plain(lines, grammar, failure);

  let tokenized: ShikiThemedToken[][];
  try {
    tokenized = runtime.highlighter.codeToTokensBase(lines.join('\n'), {
      lang: grammar,
      theme: MONO_THEME.name,
    });
  } catch (err) {
    // A grammar that throws once will throw again on the next request for the
    // same file type, so it is retired rather than retried.
    const reason = `The ${grammar} grammar failed on this file (${
      err instanceof Error ? err.message : String(err)
    }).`;
    brokenGrammars.set(grammar, reason);
    loadedGrammars.delete(grammar);
    return plain(lines, grammar, reason);
  }

  // A trailing empty line, or a grammar that answered short, must not shift the
  // viewer's line numbering — the rows are indexed positionally.
  const out: WireToken[][] = lines.map((line, i) => {
    const row = tokenized[i];
    return row ? atomize(row) : atomizePlain(line);
  });

  return { engine: 'shiki', grammar, classes: TOKEN_CLASSES, lines: out };
}

function plain(lines: readonly string[], grammar: string | null, reason?: string): HighlightResult {
  return {
    engine: 'plain',
    grammar,
    classes: TOKEN_CLASSES,
    lines: lines.map(atomizePlain),
    ...(reason ? { reason } : {}),
  };
}

/* ---------------------------------------------------------- atomisation -- */

/**
 * An identifier, in the loosest sense every indexed language agrees on.
 *
 * The high range is there because `\w` is ASCII-only in JavaScript and a symbol
 * name can be Chinese, Japanese or Cyrillic; a call site in those repositories
 * has to be linkable too.
 */
const IDENT = /[A-Za-z_$À-￿][\w$À-￿]*/g;

/**
 * Split a grammar's tokens into identifier runs, merging everything else.
 *
 * This is the step that makes the graph's call-site links independent of how a
 * grammar chose to chunk a line. TextMate is free to emit `this.mutex.withLock`
 * as one token, three, or five, and the viewer has to be able to wrap exactly
 * `withLock`; giving it identifier-sized atoms up front means the overlay only
 * ever *claims* a token, never re-cuts one.
 *
 * Comments and strings are left whole on purpose: no edge points inside one,
 * and a doc comment split into forty atoms is forty times the wire bytes for
 * nothing.
 */
function atomize(tokens: readonly ShikiThemedToken[]): WireToken[] {
  const out: WireToken[] = [];
  for (const token of tokens) {
    const cls = classOf(token.color);
    if (cls === 'comment' || cls === 'string') {
      push(out, cls, token.content);
      continue;
    }
    splitIdentifiers(out, token.content, cls);
  }
  return out;
}

function atomizePlain(line: string): WireToken[] {
  const out: WireToken[] = [];
  splitIdentifiers(out, line, 'other');
  return out;
}

/**
 * Emit `text` as alternating non-identifier and identifier runs.
 *
 * An identifier inside a token the grammar called a keyword keeps the keyword
 * class — `func` should still carry its weight — while the overlay's matcher
 * looks at a token's *text*, not its class, so a language whose grammar scopes
 * type names as `storage.type` still links.
 */
function splitIdentifiers(out: WireToken[], text: string, cls: TokenClassName): void {
  if (text === '') return;
  IDENT.lastIndex = 0;
  let at = 0;
  let match: RegExpExecArray | null;
  while ((match = IDENT.exec(text)) !== null) {
    if (match.index > at) push(out, cls === 'ident' ? 'other' : cls, text.slice(at, match.index));
    push(out, cls === 'other' ? 'ident' : cls, match[0]);
    at = match.index + match[0].length;
  }
  if (at < text.length) push(out, cls === 'ident' ? 'other' : cls, text.slice(at));
}

/** Append, merging into the previous token when it carries the same class. */
function push(out: WireToken[], cls: TokenClassName, text: string): void {
  if (text === '') return;
  const id = CLASS_ID[cls];
  const last = out[out.length - 1];
  // Identifiers are never merged: each one has to stay claimable on its own.
  if (last && last[0] === id && id !== CLASS_ID.ident) {
    last[1] += text;
    return;
  }
  out.push([id, text]);
}
