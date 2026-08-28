/**
 * Expo Router (React Native) — file-based screens and string-keyed navigation.
 *
 * Two things static extraction cannot see on its own, and that together are
 * most of what "how does the app flow" means in an Expo app:
 *
 * 1. **A screen is a file, not a symbol.** Every file under `app/` (or
 *    `src/app/`) is a route: `app/object-detail.tsx` is `/object-detail`,
 *    `app/capture/index.tsx` is `/capture`, `app/item/[id].tsx` is `/item/[id]`,
 *    and `(group)` directories are invisible in the URL. `extract()` emits one
 *    `route` node per screen file, named by its path, with a `calls` ref to the
 *    file's default export so the route reaches the component that renders it.
 *
 * 2. **Navigation is a string.** `router.push('/object-detail?…')`,
 *    `router.navigate({ pathname: '/item/[id]', params })`, a template literal
 *    with the params interpolated — the extractor records each as a `calls` ref
 *    named `router.push` that resolves to nothing, because the target is a
 *    path, not an identifier. `resolve()` claims those refs, reads the argument
 *    off the source lines, matches it against the route table, and returns a
 *    **`navigates`** edge to the route node, carrying the href it read.
 *
 * Between them the graph gains `ItemCard → openObjectDetail → /object-detail →
 * ObjectDetail`, which is the chain a reader asking "where does tapping an
 * object go" needs and previously got "no path" for.
 *
 * Precision rests on the string resolving to a real screen file, not on the
 * receiver being called `router`: `nav.push('/x')` from `const nav =
 * useRouter()` binds, `list.push('/x')` where no such route exists does not.
 * Anything the resolver cannot bind to exactly one screen — a computed path,
 * an ambiguous dynamic match, a relative href from a non-screen file — is left
 * unresolved rather than guessed. Silent beats wrong.
 *
 * Not covered yet (each needs the enclosing component, which `extract()` does
 * not receive): `<Link href>`, `<Redirect href>`, and `Stack.Screen` /
 * `Tabs.Screen` `name` props. `router.back()` / `dismiss()` have no target and
 * are correctly skipped.
 */

import type { Language, Node } from '../../types';
import type {
  FrameworkResolver,
  ResolutionContext,
  ResolvedRef,
  UnresolvedRef,
} from '../types';
import { stripCommentsForRegex } from '../strip-comments';
import { dependsOn } from './package-deps';

// =============================================================================
// Route files
// =============================================================================

const ROUTE_LANGUAGES: readonly Language[] = ['typescript', 'javascript', 'tsx', 'jsx'];

/** The app directory: `app/` at the project root, or `src/app/`. First match wins. */
const APP_DIR = /(?:^|\/)(?:src\/)?app\//;

/** A screen file's extension, with an optional platform suffix (`.ios.tsx`). */
const ROUTE_EXT = /\.(?:(?:ios|android|native|web)\.)?(tsx|ts|jsx|js|mjs|cjs)$/;

/** Files under `app/` that define a screen (not a layout, not test, not html). */
export function routePathForFile(filePath: string): string | null {
  const dir = APP_DIR.exec(filePath);
  if (!dir) return null;
  const rel = filePath.slice(dir.index + dir[0].length);
  const ext = ROUTE_EXT.exec(rel);
  if (!ext) return null;
  const bare = rel.slice(0, ext.index);
  if (bare.endsWith('.d') || /\.(?:test|spec|stories)$/.test(bare)) return null;
  const segs = bare.split('/');
  if (segs.includes('__tests__') || segs.includes('__mocks__')) return null;
  const base = segs[segs.length - 1]!;
  // `_layout` (and any other `_`-prefixed file) is not navigable. `+not-found`
  // is a real screen; the other `+` files (`+html`, `+native-intent`) are not.
  if (base.startsWith('_')) return null;
  if (base.startsWith('+') && base !== '+not-found') return null;
  const kept = segs.filter((s) => !(s.startsWith('(') && s.endsWith(')')));
  if (kept[kept.length - 1] === 'index') kept.pop();
  return '/' + kept.join('/');
}

function languageForFile(filePath: string): Language {
  const ext = ROUTE_EXT.exec(filePath)?.[1];
  switch (ext) {
    case 'tsx':
      return 'tsx';
    case 'jsx':
      return 'jsx';
    case 'ts':
      return 'typescript';
    default:
      return 'javascript';
  }
}

const IDENT = '[A-Za-z_$][\\w$]*';

/**
 * The name the file exports as its screen. Expo renders the DEFAULT export,
 * so that is the only binding that matters; a wrapper (`memo(Screen)`,
 * `observer(Screen)`, `React.forwardRef(Screen)`) is looked through to its
 * first identifier argument. Anonymous defaults (`export default () => …`)
 * have no name to bind and yield null.
 */
export function defaultExportName(stripped: string): { name: string; index: number } | null {
  const patterns: RegExp[] = [
    new RegExp(`export\\s+default\\s+(?:async\\s+)?function\\s*\\*?\\s*(${IDENT})`),
    new RegExp(`export\\s+default\\s+class\\s+(${IDENT})`),
    new RegExp(`export\\s+default\\s+(?:${IDENT}\\.)?${IDENT}\\s*\\(\\s*(${IDENT})\\s*[,)]`),
    new RegExp(`export\\s+default\\s+(${IDENT})\\s*;?\\s*$`, 'm'),
    new RegExp(`export\\s*\\{\\s*(${IDENT})\\s+as\\s+default\\s*\\}`),
  ];
  for (const re of patterns) {
    const m = re.exec(stripped);
    if (m && m[1] && m[1] !== 'default') return { name: m[1], index: m.index };
  }
  return null;
}

// =============================================================================
// Reading the href out of a navigation call
// =============================================================================

/**
 * The `router` methods that take a destination (`back`/`dismiss` take none),
 * and a project's own wrappers around them: `safePush('/x')`,
 * `guardedNavigate('/x')` — a camelCase name ending in the verb. A wrapper
 * usually defers the real call through state the graph cannot follow
 * (`pendingNav = { method, href }` … `router[method](href)`), so its NAME is
 * the only static evidence; the argument resolving to a real screen is what
 * makes the claim safe. Second group: the verb, when it came from a wrapper.
 */
export const NAV_METHOD = /(?:^|\.)(push|replace|navigate|dismissTo)$|^[a-z][A-Za-z]*(Push|Replace|Navigate)$/;

/** The verb a NAV_METHOD match names, lower-cased: `safePush` → `push`. */
export function navVerb(name: string): string | null {
  const m = NAV_METHOD.exec(name);
  if (!m) return null;
  // A router method is already the verb (`dismissTo`); a wrapper's suffix
  // (`safePush` → `Push`) is lower-cased to name the verb it stands in for.
  return m[1] ?? m[2]!.toLowerCase();
}

/** Lines a single navigation call is allowed to span. */
const MAX_CALL_LINES = 12;

/** Placeholder for an interpolated `${…}` inside a template-literal href (shared with the cross-tier synthesizer). */
export const HOLE = '\u0000';

/** Index of the `)` matching the `(` at `open`, skipping string bodies; -1 if unbalanced. */
function matchParen(s: string, open: number): number {
  let depth = 0;
  for (let i = open; i < s.length; i++) {
    const ch = s[i];
    if (ch === '"' || ch === "'") {
      const q = ch;
      i++;
      while (i < s.length && s[i] !== q) {
        if (s[i] === '\\') i++;
        i++;
      }
      continue;
    }
    if (ch === '`') {
      i = skipTemplate(s, i);
      continue;
    }
    if (ch === '(') depth++;
    else if (ch === ')') {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/** Index of the closing backtick for the template starting at `open`. */
function skipTemplate(s: string, open: number): number {
  let i = open + 1;
  while (i < s.length) {
    const ch = s[i];
    if (ch === '\\') {
      i += 2;
      continue;
    }
    if (ch === '`') return i;
    if (ch === '$' && s[i + 1] === '{') {
      let depth = 0;
      for (i = i + 1; i < s.length; i++) {
        if (s[i] === '{') depth++;
        else if (s[i] === '}') {
          depth--;
          if (depth === 0) break;
        } else if (s[i] === '`') i = skipTemplate(s, i);
      }
    }
    i++;
  }
  return s.length;
}

/** Index of the quote that closes the string literal opening at `at` (or the end of `s`). */
export function stringEnd(s: string, at: number): number {
  const q = s[at];
  if (q === '`') return skipTemplate(s, at);
  for (let i = at + 1; i < s.length; i++) {
    if (s[i] === '\\') i++;
    else if (s[i] === q) return i;
  }
  return s.length;
}

/**
 * A string literal (`'…'`, `"…"`, or a template) starting at `at`, as text
 * with every `${…}` replaced by {@link HOLE}. Null when `at` is not a string.
 */
export function readStringAt(s: string, at: number): string | null {
  const q = s[at];
  if (q === '"' || q === "'") {
    let out = '';
    for (let i = at + 1; i < s.length; i++) {
      const ch = s[i]!;
      if (ch === '\\') {
        out += s[i + 1] ?? '';
        i++;
        continue;
      }
      if (ch === q) return out;
      out += ch;
    }
    return null;
  }
  if (q === '`') {
    const end = skipTemplate(s, at);
    let out = '';
    for (let i = at + 1; i < end; i++) {
      const ch = s[i]!;
      if (ch === '\\') {
        out += s[i + 1] ?? '';
        i++;
        continue;
      }
      if (ch === '$' && s[i + 1] === '{') {
        let depth = 0;
        for (i = i + 1; i < end; i++) {
          if (s[i] === '{') depth++;
          else if (s[i] === '}') {
            depth--;
            if (depth === 0) break;
          }
        }
        out += HOLE;
        continue;
      }
      out += ch;
    }
    return out;
  }
  return null;
}

export interface HrefLiteral {
  /** The path part, `${…}` holes kept as {@link HOLE}; query and hash removed. */
  path: string;
  /** The literal as written, holes rendered as `${…}` — for the edge metadata. */
  display: string;
  /** The other arm of a `cond ? a : b` argument, when the argument was one. */
  alternate?: HrefLiteral;
}

/** Index of the first `ch` at bracket depth 0 and outside strings, or -1. */
function indexAtDepth0(s: string, ch: string, from: number): number {
  let depth = 0;
  for (let i = from; i < s.length; i++) {
    const c = s[i];
    if (c === '"' || c === "'") {
      const q = c;
      i++;
      while (i < s.length && s[i] !== q) {
        if (s[i] === '\\') i++;
        i++;
      }
      continue;
    }
    if (c === '`') {
      i = skipTemplate(s, i);
      continue;
    }
    if (c === '(' || c === '[' || c === '{') depth++;
    else if (c === ')' || c === ']' || c === '}') depth--;
    else if (c === '?' && (s[i + 1] === '.' || s[i + 1] === '?')) i++; // `?.` / `??`
    else if (depth === 0 && c === ch) return i;
  }
  return -1;
}

export function toHref(literal: string | null): HrefLiteral | null {
  if (literal === null || literal.length === 0) return null;
  const cut = literal.search(/[?#]/);
  const path = cut < 0 ? literal : literal.slice(0, cut);
  if (path.length === 0) return null;
  return { path, display: literal.split(HOLE).join('${…}') };
}

/**
 * The href in one argument expression: a string, a template, an `Href` object
 * with a literal `pathname`, or a conditional whose two arms are each one of
 * those (`cond ? \`/x?id=${id}\` : '/x'`). Anything else is not static.
 */
export function parseHrefExpression(expr: string): HrefLiteral | null {
  // `expr as any` / `expr satisfies Href` — a cast says nothing about the value.
  let args = expr.trim().replace(/\s+(?:as|satisfies)\s+[\w$.<>[\]|&\s]+$/, '');
  // `(a ? b : c)` — unwrap one layer of grouping parens.
  while (args.startsWith('(') && matchParen(args, 0) === args.length - 1) {
    args = args.slice(1, -1).trim().replace(/\s+(?:as|satisfies)\s+[\w$.<>[\]|&\s]+$/, '');
  }
  if (args.length === 0) return null;
  const q = indexAtDepth0(args, '?', 0);
  if (q > 0) {
    const colon = indexAtDepth0(args, ':', q + 1);
    if (colon > q) {
      const yes = parseHrefExpression(args.slice(q + 1, colon));
      const no = parseHrefExpression(args.slice(colon + 1));
      if (yes && no) return { ...yes, alternate: no };
      return null;
    }
  }
  if (args[0] === '{') {
    const key = /\bpathname\s*:\s*/.exec(args);
    return key ? toHref(readStringAt(args, key.index + key[0].length)) : null;
  }
  return toHref(readStringAt(args, 0));
}

/**
 * The destination of the navigation call at (`line`, `column`) in `lines`.
 *
 * Handles the three shapes Expo Router accepts: a string, a template literal
 * (static prefix kept, interpolations become holes), and an `Href` object
 * whose `pathname` is one of those. Anything else — a variable, a call, a
 * spread — is not a literal and returns null.
 */
export function readHrefArgument(
  lines: readonly string[],
  line: number,
  column: number,
  method: string
): HrefLiteral | null {
  const arg = firstArgumentText(lines, line, column, method);
  return arg === null ? null : parseHrefExpression(arg);
}

/** The source text of the navigation call's first argument, or null when there is no call there. */
export function firstArgumentText(
  lines: readonly string[],
  line: number,
  column: number,
  method: string
): string | null {
  const first = line - 1;
  if (first < 0 || first >= lines.length) return null;
  const text = lines.slice(first, first + MAX_CALL_LINES).join('\n');
  const nameAt = text.indexOf(method, Math.max(0, column));
  if (nameAt < 0) return null;
  let open = nameAt + method.length;
  while (open < text.length && /\s/.test(text[open]!)) open++;
  if (text[open] !== '(') return null;
  const close = matchParen(text, open);
  const args = text.slice(open + 1, close < 0 ? undefined : close);
  // Only the first argument: a `,` at depth 0 ends it (`push(href, opts)`).
  const comma = indexAtDepth0(args, ',', 0);
  return comma < 0 ? args : args.slice(0, comma);
}

const CAST_TAIL = /\s+(?:as|satisfies)\s+[\w$.<>[\]|&\s]+$/;

/** A line that continues the previous statement rather than starting a new one. */
const CONTINUATION = /^[?:.)\]}`'"+&|]/;

/**
 * The href a navigation call reaches through a local variable:
 *
 *   const href = params.length ? `/barcode-scan?${q}` : '/barcode-scan'
 *   router.navigate(href as any)
 *
 * When the argument is a bare identifier, its most recent `const`/`let`
 * declaration between `enclosingStart` and the call is read and its
 * initializer parsed exactly like a literal argument would be. A reassignment
 * in between, or an initializer that is not static, yields null.
 */
export function readHrefViaLocal(
  lines: readonly string[],
  line: number,
  column: number,
  method: string,
  enclosingStart: number
): HrefLiteral | null {
  const arg = firstArgumentText(lines, line, column, method);
  if (arg === null) return null;
  const ident = arg.trim().replace(CAST_TAIL, '');
  if (!/^[A-Za-z_$][\w$]*$/.test(ident)) return null;
  const decl = new RegExp(`\\b(?:const|let|var)\\s+${ident.replace(/\$/g, '\\$')}\\s*(?::[^=]*?)?=(?!=)`);
  const reassign = new RegExp(`(?:^|[^.\\w$])${ident.replace(/\$/g, '\\$')}\\s*=(?!=)`);
  const from = Math.max(0, enclosingStart - 1);
  for (let i = line - 2; i >= from; i--) {
    const text = lines[i]!;
    const m = decl.exec(text);
    if (!m) {
      // The variable assigned again between declaration and use — not static.
      if (reassign.test(text)) return null;
      continue;
    }
    // The initializer: the rest of this line, plus continuation lines.
    let init = text.slice(m.index + m[0].length);
    for (let j = i + 1; j < line - 1 && j < i + MAX_CALL_LINES; j++) {
      const next = lines[j]!;
      if (!CONTINUATION.test(next.trimStart()) && balanced(init)) break;
      init += '\n' + next;
    }
    return parseHrefExpression(init);
  }
  return null;
}

/** True when every bracket and template opened in `s` is closed. */
function balanced(s: string): boolean {
  let depth = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '"' || c === "'" || c === '`') {
      const end = stringEnd(s, i);
      if (end >= s.length) return false;
      i = end;
      continue;
    }
    if (c === '(' || c === '[' || c === '{') depth++;
    else if (c === ')' || c === ']' || c === '}') depth--;
  }
  return depth <= 0;
}

// =============================================================================
// Route table
// =============================================================================

interface RouteEntry {
  node: Node;
  segs: string[];
}

export interface RouteTable {
  /** Identity of the node array the table was built from — rebuild when it changes. */
  source: readonly Node[];
  exact: Map<string, Node>;
  dynamic: RouteEntry[];
}

const tables = new Map<string, RouteTable>();

export function routeTable(context: ResolutionContext): RouteTable {
  const all = context.getNodesByKind('route');
  const key = context.getProjectRoot();
  const cached = tables.get(key);
  if (cached && cached.source === all) return cached;
  const exact = new Map<string, Node>();
  const dynamic: RouteEntry[] = [];
  for (const node of all) {
    // Only this framework's own route nodes: the ones whose name IS the path
    // derived from their file. Express/SvelteKit routes in the same project
    // name themselves differently and never match.
    if (routePathForFile(node.filePath) !== node.name) continue;
    exact.set(node.name, node);
    if (node.name.includes('[')) dynamic.push({ node, segs: node.name.split('/').slice(1) });
  }
  const table = { source: all, exact, dynamic };
  tables.set(key, table);
  return table;
}

/**
 * Normalize an href path to the form route names use: leading `/`, no
 * trailing `/`, no `(group)` segments, holes as a whole-segment `*`.
 * A relative href is resolved against the screen the call sits in; from a
 * non-screen file it has no base and returns null.
 */
export function normalizeHrefPath(path: string, fromFile: string): string[] | null {
  let p = path;
  if (!p.startsWith('/')) {
    // Expo resolves `./x` and bare `x` against the DIRECTORY of the screen file
    // the call sits in — `/capture` for both `capture/index.tsx` and
    // `capture/review.tsx` — which is the route of that directory's index.
    if (routePathForFile(fromFile) === null) return null;
    const dirRoute = routePathForFile(fromFile.slice(0, fromFile.lastIndexOf('/') + 1) + 'index.tsx');
    if (dirRoute === null) return null;
    const parent = dirRoute.split('/').slice(1);
    if (p.startsWith('./')) p = '/' + [...parent, p.slice(2)].join('/');
    else if (p.startsWith('../')) {
      const up: string[] = [...parent];
      while (p.startsWith('../')) {
        up.pop();
        p = p.slice(3);
      }
      p = '/' + [...up, p].join('/');
    } else p = '/' + [...parent, p].join('/');
  }
  const segs = p
    .split('/')
    .slice(1)
    .filter((s) => s.length > 0 && !(s.startsWith('(') && s.endsWith(')')))
    .map((s) => (s.includes(HOLE) ? '*' : decodeSegment(s)));
  return segs;
}

function decodeSegment(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

/**
 * The single route the href segments denote, or null when none or several do.
 *
 * Scored so that a literal segment beats a wildcard for the same slot and a
 * `[param]` slot accepts either; a tie between two routes is ambiguity, and
 * ambiguity is a null, not a coin flip.
 */
export function matchRoute(segs: string[], table: RouteTable): Node | null {
  const exact = table.exact.get('/' + segs.join('/'));
  if (exact) return exact;
  let best: { node: Node; score: number } | null = null;
  let tied = false;
  for (const entry of table.dynamic) {
    const score = scoreMatch(segs, entry.segs);
    if (score === null) continue;
    if (best === null || score > best.score) {
      best = { node: entry.node, score };
      tied = false;
    } else if (score === best.score) tied = true;
  }
  return best && !tied ? best.node : null;
}

/** A route segment that takes a value: Expo's `[id]`, or the `:id` every other framework's routes use. */
function isParamSegment(seg: string): boolean {
  return (seg.startsWith('[') && seg.endsWith(']')) || (seg.startsWith(':') && !seg.endsWith('*'));
}

/** A route segment that takes the rest of the path: `[...slug]`, or `:slug*`. */
function isCatchAllSegment(seg: string): boolean {
  return (seg.startsWith('[...') && seg.endsWith(']')) || (seg.startsWith(':') && seg.endsWith('*'));
}

function scoreMatch(href: string[], route: string[]): number | null {
  let score = 0;
  let i = 0;
  for (let r = 0; r < route.length; r++) {
    const seg = route[r]!;
    if (isCatchAllSegment(seg)) {
      // Catch-all: needs at least one segment and takes the rest.
      if (i >= href.length) return null;
      score += href.length - i;
      i = href.length;
      continue;
    }
    if (i >= href.length) return null;
    const h = href[i]!;
    if (isParamSegment(seg)) score += 2;
    else if (h === seg) score += 3;
    else if (h === '*') score += 1;
    else return null;
    i++;
  }
  return i === href.length ? score : null;
}

// =============================================================================
// The resolver
// =============================================================================

export const expoRouterResolver: FrameworkResolver = {
  name: 'expo-router',
  languages: [...ROUTE_LANGUAGES],

  detect(context: ResolutionContext): boolean {
    if (dependsOn(context, 'expo-router')) return true;
    const files = context.getAllFiles();
    const hasLayout = files.some((f) => /(?:^|\/)(?:src\/)?app\/_layout\.(?:tsx|jsx|ts|js)$/.test(f));
    const hasExpoConfig = files.some((f) => /^app\.(?:json|config\.(?:js|ts))$/.test(f));
    return hasLayout && hasExpoConfig;
  },

  claimsReference(name: string): boolean {
    return NAV_METHOD.test(name);
  },

  extract(filePath: string, content: string) {
    const routePath = routePathForFile(filePath);
    if (routePath === null) return { nodes: [], references: [] };
    const language = languageForFile(filePath);
    const node: Node = {
      id: `route:${filePath}:${routePath}`,
      kind: 'route',
      name: routePath,
      qualifiedName: `${filePath}::route:${routePath}`,
      filePath,
      startLine: 1,
      endLine: 1,
      startColumn: 0,
      endColumn: 0,
      language,
      isExported: true,
      updatedAt: Date.now(),
    };
    const references: UnresolvedRef[] = [];
    const stripped = stripCommentsForRegex(content, 'typescript');
    const screen = defaultExportName(stripped);
    if (screen) {
      references.push({
        fromNodeId: node.id,
        referenceName: screen.name,
        referenceKind: 'calls',
        line: stripped.slice(0, screen.index).split('\n').length,
        column: 0,
        filePath,
        language,
        candidates: [screen.name],
      });
    }
    return { nodes: [node], references };
  },

  resolve(ref: UnresolvedRef, context: ResolutionContext): ResolvedRef | null {
    if (ref.referenceKind !== 'calls') return null;
    const method = navVerb(ref.referenceName);
    if (!method) return null;
    if (!ROUTE_LANGUAGES.includes(ref.language)) return null;
    // The name to find on the line: `navigate` in `router.navigate(`, or the
    // wrapper's own name in `safePush(`.
    const callee = ref.referenceName.slice(ref.referenceName.lastIndexOf('.') + 1);

    const lines =
      context.getFileLines?.(ref.filePath) ?? context.readFile(ref.filePath)?.split(/\r?\n/) ?? null;
    if (!lines) return null;
    let href = readHrefArgument(lines, ref.line, ref.column, callee);
    if (!href) {
      const enclosing = context.getNodeById?.(ref.fromNodeId);
      const start = enclosing && enclosing.filePath === ref.filePath ? enclosing.startLine : Math.max(1, ref.line - 40);
      href = readHrefViaLocal(lines, ref.line, ref.column, callee, start);
    }
    if (!href) return null;
    const table = routeTable(context);
    const segs = normalizeHrefPath(href.path, ref.filePath);
    if (segs === null) return null;
    const target = matchRoute(segs, table);
    if (!target) return null;
    if (href.alternate) {
      // `cond ? a : b` — one edge can carry one destination. Both arms
      // reaching the same screen (a query-string difference, typically) is a
      // confident bind; two different screens is a fork this ref can't record.
      const altSegs = normalizeHrefPath(href.alternate.path, ref.filePath);
      if (altSegs === null || matchRoute(altSegs, table)?.id !== target.id) return null;
    }

    return {
      original: ref,
      targetNodeId: target.id,
      confidence: 0.95,
      resolvedBy: 'framework',
      edgeKind: 'navigates',
      metadata: { href: href.display, navMethod: method, ...(callee !== method ? { via: callee } : {}) },
    };
  },
};
