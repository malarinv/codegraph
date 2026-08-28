/**
 * Branch guards — the conditions under which a call site runs.
 *
 * An edge says `handlePress → openObjectDetail`. What a reader wants to know
 * is that it happens **when `isCollected`** and **not while `isUploading`**:
 *
 *   if (isUploading) return            ← early-return guard: !isUploading
 *   if (isCollected) {                 ← if: isCollected
 *     openObjectDetail(item)           ← the call site
 *
 * This module derives that from the AST at query time. Given a file, its
 * language and a call site (line, column), it walks from the innermost node at
 * that position up to the enclosing function boundary and records every
 * branch it passes through: `if` / `else` / `else if`, the arms of a ternary,
 * `switch` cases, the right side of `&&` / `||`, a `catch`, and — at each
 * statement block on the way — the early exits that precede the site
 * (`if (x) return`, Swift `guard x else { return }`).
 *
 * Nothing is stored in the index. The viewer and `codegraph_explore` already
 * re-read source per request (drift checks, source windows, highlighting), the
 * grammars are loaded in both processes, and a file parses in about a
 * millisecond — so labels are computed where they are shown, from the source
 * as it is now, and the index schema and the native kernel are untouched. A
 * small LRU keeps the last few parsed trees so a Symbol view that asks about
 * forty call sites in one file parses it once.
 *
 * Only what the AST states is reported. Loops are not conditions and are not
 * listed; a condition that cannot be read (a language without rules here, a
 * file that will not parse) yields no label rather than a wrong one.
 */

import * as fs from 'fs';
import type { Node as SyntaxNode, Tree } from 'web-tree-sitter';
import type { Language } from '../types';
import { getParser, loadGrammarsForLanguages } from '../extraction/grammars';

// =============================================================================
// Public shape
// =============================================================================

export type GuardForm = 'if' | 'else' | 'ternary' | 'case' | 'guard' | 'and' | 'or' | 'catch';

export interface BranchGuard {
  /** The condition's source, whitespace-collapsed, outer parens dropped, capped in length. */
  text: string;
  /** The site runs when the condition is FALSE (an else arm, an early-return guard, `||`). */
  negated: boolean;
  form: GuardForm;
  /** Line of the condition (1-based). */
  line: number;
}

/** Longest condition text kept before it is cut with an ellipsis. */
const MAX_TEXT = 80;

const JS_FAMILY: ReadonlySet<Language> = new Set(['typescript', 'javascript', 'tsx', 'jsx']);

/** Languages with walk rules below. Others yield no guards (never a wrong one). */
export function supportsBranchGuards(language: Language | string | undefined | null): boolean {
  return !!language && (JS_FAMILY.has(language as Language) || language === 'swift');
}

/**
 * The label a rail or a flow connector prints: the conditions in execution
 * order, joined with `&&`, each negated one written as `!x`. Empty when the
 * site is unconditional.
 */
export function guardLabel(guards: readonly BranchGuard[]): string {
  return guards.map(renderGuard).join(' && ');
}

function renderGuard(g: BranchGuard): string {
  if (g.form === 'catch') return g.text;
  // `if (!object?.id || !object?.name)` joined to the guard before it with
  // `&&` would read as two conditions: it keeps its parentheses.
  if (!g.negated) return hasTopLevelOr(g.text) ? `(${g.text})` : g.text;
  // `!x` negated reads back as `x`; a simple operand takes a bare `!`;
  // anything with operators is parenthesised so the negation is unambiguous.
  if (/^!(?![=])/.test(g.text) && isSimpleOperand(g.text.slice(1))) return g.text.slice(1);
  return isSimpleOperand(g.text) ? `!${g.text}` : `!(${g.text})`;
}

/** A `||` outside every bracket and string — the condition is a disjunction as written. */
function hasTopLevelOr(text: string): boolean {
  let depth = 0;
  let quote: string | null = null;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (quote !== null) {
      if (ch === '\\') i++;
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') quote = ch;
    else if (ch === '(' || ch === '[' || ch === '{') depth++;
    else if (ch === ')' || ch === ']' || ch === '}') depth = Math.max(0, depth - 1);
    else if (depth === 0 && ch === '|' && text[i + 1] === '|') return true;
  }
  return false;
}

function isSimpleOperand(text: string): boolean {
  return /^[\w$.?!]+(?:\([^()]*\))?$/.test(text) && !/[=<>]/.test(text);
}

// =============================================================================
// Trees, cached per file version
// =============================================================================

interface CachedTree {
  key: string;
  tree: Tree;
  source: string;
}

const TREE_CACHE_SIZE = 8;
const treeCache = new Map<string, CachedTree>();

/**
 * Files above this size are not parsed for labels. A 300 KB source file costs
 * tens of milliseconds to parse, and a Symbol view is budgeted at 100 ms end
 * to end; a call site in such a file simply shows no `when`.
 */
export const MAX_PARSE_BYTES = 256 * 1024;

/** The `web-tree-sitter` trees held above are native memory: evict explicitly. */
function remember(path: string, entry: CachedTree): void {
  const old = treeCache.get(path);
  if (old) old.tree.delete();
  treeCache.delete(path);
  treeCache.set(path, entry);
  if (treeCache.size > TREE_CACHE_SIZE) {
    const oldest = treeCache.keys().next().value as string;
    treeCache.get(oldest)?.tree.delete();
    treeCache.delete(oldest);
  }
}

async function treeFor(absPath: string, language: Language): Promise<CachedTree | null> {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(absPath);
  } catch {
    return null;
  }
  const key = `${language}:${stat.mtimeMs}:${stat.size}`;
  const hit = treeCache.get(absPath);
  if (hit && hit.key === key) return hit;
  if (stat.size > MAX_PARSE_BYTES) return null;
  let source: string;
  try {
    source = fs.readFileSync(absPath, 'utf8');
  } catch {
    return null;
  }
  const tree = await parse(source, language);
  if (!tree) return null;
  const entry = { key, tree, source };
  remember(absPath, entry);
  return entry;
}

async function parse(source: string, language: Language): Promise<Tree | null> {
  try {
    await loadGrammarsForLanguages([language]);
    const parser = getParser(language);
    if (!parser) return null;
    return parser.parse(source) ?? null;
  } catch {
    return null;
  }
}

// =============================================================================
// Entry points
// =============================================================================

export interface CallSite {
  line: number;
  /** 0-based; null/undefined = the first non-blank column of the line. */
  column?: number | null;
}

export function siteKey(site: CallSite): string {
  return `${site.line}:${typeof site.column === 'number' ? site.column : ''}`;
}

/**
 * Guards for many call sites in one file, keyed by {@link siteKey}. The file
 * is parsed once (and cached across requests until it changes on disk). A
 * language without rules, or a file that cannot be read or parsed, yields an
 * empty map.
 */
export async function guardsForFile(
  absPath: string,
  language: Language,
  sites: readonly CallSite[]
): Promise<Map<string, BranchGuard[]>> {
  const out = new Map<string, BranchGuard[]>();
  if (!supportsBranchGuards(language) || sites.length === 0) return out;
  const cached = await treeFor(absPath, language);
  if (!cached) return out;
  for (const site of sites) {
    const key = siteKey(site);
    if (out.has(key)) continue;
    out.set(key, guardsInTree(cached.tree.rootNode, cached.source, language, site.line, site.column ?? null));
  }
  return out;
}

/**
 * Synchronous twin of {@link guardsForFile} for callers that cannot await
 * (the explore text builder). It only serves languages whose grammar is
 * ALREADY loaded — see {@link warmBranchGuardGrammars} — and yields an empty
 * map otherwise, never a wrong label.
 */
export function guardsForFileSync(
  absPath: string,
  language: Language,
  sites: readonly CallSite[]
): Map<string, BranchGuard[]> {
  const out = new Map<string, BranchGuard[]>();
  if (!supportsBranchGuards(language) || sites.length === 0) return out;
  let stat: fs.Stats;
  try {
    stat = fs.statSync(absPath);
  } catch {
    return out;
  }
  const key = `${language}:${stat.mtimeMs}:${stat.size}`;
  let cached = treeCache.get(absPath);
  if (!cached || cached.key !== key) {
    if (stat.size > MAX_PARSE_BYTES) return out;
    const parser = getParser(language);
    if (!parser) return out;
    let source: string;
    try {
      source = fs.readFileSync(absPath, 'utf8');
    } catch {
      return out;
    }
    const tree = parser.parse(source);
    if (!tree) return out;
    cached = { key, tree, source };
    remember(absPath, cached);
  }
  for (const site of sites) {
    const k = siteKey(site);
    if (!out.has(k)) out.set(k, guardsInTree(cached.tree.rootNode, cached.source, language, site.line, site.column ?? null));
  }
  return out;
}

/** The languages with rules here — what {@link warmBranchGuardGrammars} loads. */
export const BRANCH_GUARD_LANGUAGES: readonly Language[] = ['typescript', 'tsx', 'javascript', 'jsx', 'swift'];

// =============================================================================
// Call arguments — what a site passes
// =============================================================================

/** Longest argument list kept before it is cut with an ellipsis. */
const MAX_ARGS_TEXT = 96;
/** Longest single argument (a string literal, a name) kept whole. */
const MAX_ARG_TEXT = 40;
/** Object keys listed before `…` stands for the rest. */
const MAX_OBJECT_KEYS = 4;
const CALL_TYPES: ReadonlySet<string> = new Set(['call_expression', 'new_expression']);
const ARGUMENT_CONTAINERS: ReadonlySet<string> = new Set(['arguments', 'value_arguments', 'argument_list']);
const STRING_TYPES: ReadonlySet<string> = new Set([
  'string',
  'template_string',
  'line_string_literal',
  'multi_line_string_literal',
  'raw_string_literal',
]);
const OBJECT_TYPES: ReadonlySet<string> = new Set(['object', 'object_expression']);
const ARRAY_TYPES: ReadonlySet<string> = new Set(['array', 'array_literal', 'dictionary_literal']);
const FUNCTION_TYPES: ReadonlySet<string> = new Set(['arrow_function', 'function_expression', 'function']);

/**
 * The arguments a call site passes, as written, abbreviated to what a reader
 * scans for: a string literal whole (a storage key, a URL, a message), a name
 * whole, an object as its keys (`{ email, password }`), an array as `[…]`, a
 * function as `() => …`, a nested call as `f(…)`. The conditions say WHEN a
 * step runs; this says WITH WHAT — `SecureStore.setItemAsync('userEmail',
 * values.email)` is a different fact from `SecureStore.setItemAsync`.
 *
 * Keyed by {@link siteKey} like the guards, read from the same cached tree.
 * A site that is not inside a call, or a language without rules, is absent.
 */
export async function callArgumentsForFile(
  absPath: string,
  language: Language,
  sites: readonly CallSite[]
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (!supportsBranchGuards(language) || sites.length === 0) return out;
  const cached = await treeFor(absPath, language);
  if (!cached) return out;
  for (const site of sites) {
    const key = siteKey(site);
    if (out.has(key)) continue;
    const text = callArgumentsInTree(cached.tree.rootNode, cached.source, site.line, site.column ?? null);
    if (text !== null) out.set(key, text);
  }
  return out;
}

/** {@link callArgumentsForFile} over source text — the test surface. */
export async function callArgumentsInSource(
  source: string,
  language: Language,
  line: number,
  column: number | null
): Promise<string | null> {
  if (!supportsBranchGuards(language)) return null;
  const tree = await parse(source, language);
  if (!tree) return null;
  try {
    return callArgumentsInTree(tree.rootNode, source, line, column);
  } finally {
    tree.delete();
  }
}

export function callArgumentsInTree(
  root: SyntaxNode,
  source: string,
  line: number,
  column: number | null
): string | null {
  const row = line - 1;
  const col = column ?? firstNonBlankColumn(source, row);
  const start = innermostAt(root, row, col);
  if (!start) return null;
  // The site's position is on the callee (`setItemAsync` in
  // `SecureStore.setItemAsync(…)`): climb to the call it belongs to. A few
  // levels cover a member chain; further up would be another statement.
  let call: SyntaxNode | null = null;
  let node: SyntaxNode | null = start;
  for (let up = 0; node && up < 6; up++, node = node.parent) {
    if (CALL_TYPES.has(node.type)) {
      call = node;
      break;
    }
  }
  if (!call) return null;
  const container = argumentsOf(call);
  if (!container) return null;
  if (container.type === 'lambda_literal') return '{ … }';
  const parts: string[] = [];
  for (let i = 0; i < container.namedChildCount; i++) {
    const c = container.namedChild(i);
    if (!c || c.type === 'comment') continue;
    parts.push(abbreviateArgument(c, source));
  }
  const text = parts.join(', ');
  return text.length > MAX_ARGS_TEXT ? `${text.slice(0, MAX_ARGS_TEXT - 1)}…` : text;
}

/** The node holding a call's arguments: the `arguments` field, a container child, or Swift's `call_suffix` contents. */
function argumentsOf(call: SyntaxNode): SyntaxNode | null {
  const field = call.childForFieldName('arguments');
  if (field) return field;
  for (let i = 0; i < call.namedChildCount; i++) {
    const c = call.namedChild(i);
    if (!c) continue;
    if (ARGUMENT_CONTAINERS.has(c.type)) return c;
    if (c.type === 'call_suffix') {
      for (let j = 0; j < c.namedChildCount; j++) {
        const inner = c.namedChild(j);
        if (inner && (ARGUMENT_CONTAINERS.has(inner.type) || inner.type === 'lambda_literal')) return inner;
      }
      return c;
    }
  }
  return null;
}

function abbreviateArgument(node: SyntaxNode, source: string): string {
  const type = node.type;
  if (STRING_TYPES.has(type)) return cut(collapse(node.text), MAX_ARG_TEXT);
  if (OBJECT_TYPES.has(type)) return objectKeys(node, source);
  if (ARRAY_TYPES.has(type)) return '[…]';
  if (FUNCTION_TYPES.has(type)) return '() => …';
  if (type === 'lambda_literal') return '{ … }';
  if (type === 'spread_element') return cut(collapse(node.text), MAX_ARG_TEXT);
  if (type === 'await_expression') {
    const inner = node.namedChild(0);
    return inner ? `await ${abbreviateArgument(inner, source)}` : 'await …';
  }
  if (CALL_TYPES.has(type)) {
    const callee = node.childForFieldName('function') ?? node.childForFieldName('constructor') ?? node.namedChild(0);
    const name = callee ? cut(collapse(callee.text), 28) : '';
    return `${type === 'new_expression' ? 'new ' : ''}${name}(…)`;
  }
  // Swift `label: value` — the label is half the meaning (`withName:`).
  if (type === 'value_argument') {
    const named: SyntaxNode[] = [];
    for (let i = 0; i < node.namedChildCount; i++) {
      const c = node.namedChild(i);
      if (c) named.push(c);
    }
    if (named.length >= 2 && (named[0]!.type === 'simple_identifier' || named[0]!.type === 'value_argument_label')) {
      return `${named[0]!.text}: ${abbreviateArgument(named[named.length - 1]!, source)}`;
    }
    return named.length > 0 ? abbreviateArgument(named[named.length - 1]!, source) : cut(collapse(node.text), MAX_ARG_TEXT);
  }
  if (type === 'lambda_argument' || type === 'trailing_closure') return '{ … }';
  return cut(collapse(node.text), MAX_ARG_TEXT);
}

/** `{ email, password, …}` — the keys an object literal passes, not its bulk. */
function objectKeys(node: SyntaxNode, source: string): string {
  const keys: string[] = [];
  let more = 0;
  for (let i = 0; i < node.namedChildCount; i++) {
    const c = node.namedChild(i);
    if (!c || c.type === 'comment') continue;
    let key: string | null = null;
    if (c.type === 'pair') key = c.childForFieldName('key')?.text ?? null;
    else if (c.type === 'shorthand_property_identifier' || c.type === 'shorthand_property_identifier_pattern') key = c.text;
    else if (c.type === 'spread_element') key = collapse(c.text);
    else if (c.type === 'method_definition') key = c.childForFieldName('name')?.text ?? null;
    if (key === null) continue;
    if (keys.length >= MAX_OBJECT_KEYS) {
      more++;
      continue;
    }
    keys.push(cut(key, 24));
  }
  void source;
  if (keys.length === 0) return '{…}';
  return `{ ${keys.join(', ')}${more > 0 ? ', …' : ''} }`;
}

// =============================================================================
// Triggers — what fires a site
// =============================================================================

/**
 * What binds a call site to an event, when something does — the answer to
 * "at what point does this run": the JSX attribute the site sits under
 * (`onPress` of `<Button>`), the `on*` option it is written in (`onSubmit`
 * of `useFormik({…})`), or the runs-later call it is an argument of
 * (`useEffect`, `setTimeout`, `addListener('x')`, `.then`).
 */
export interface SiteTrigger {
  kind: 'prop' | 'option' | 'callback';
  /** `onPress`, `onSubmit`, `useEffect`, `addListener`. */
  name: string;
  /** `Button` for a prop, `useFormik` for an option, the first string argument for a callback; null when unknown. */
  of: string | null;
}

/** Callees whose function argument runs LATER — a callback, not a call. Matched on the last segment. */
const LATER_CALLEES: ReadonlySet<string> = new Set([
  'useEffect',
  'useLayoutEffect',
  'useFocusEffect',
  'useImperativeHandle',
  'setTimeout',
  'setInterval',
  'requestAnimationFrame',
  'requestIdleCallback',
  'runAfterInteractions',
  'addListener',
  'addEventListener',
  'on',
  'once',
  'subscribe',
  'then',
  'catch',
  'finally',
  'runOnJS',
  'runOnUI',
  'scheduleOnRN',
]);
/** The walk up never leaves the function the site belongs to — unless that function is inline. */
const TRIGGER_BOUNDARIES: ReadonlySet<string> = new Set(['function_declaration', 'method_definition', 'class_declaration', 'class_body', 'program']);
const MAX_TRIGGER_CLIMB = 24;

export async function triggersForFile(
  absPath: string,
  language: Language,
  sites: readonly CallSite[]
): Promise<Map<string, SiteTrigger>> {
  const out = new Map<string, SiteTrigger>();
  if (!JS_FAMILY.has(language) || sites.length === 0) return out;
  const cached = await treeFor(absPath, language);
  if (!cached) return out;
  for (const site of sites) {
    const key = siteKey(site);
    if (out.has(key)) continue;
    const t = triggerInTree(cached.tree.rootNode, cached.source, site.line, site.column ?? null);
    if (t !== null) out.set(key, t);
  }
  return out;
}

/** {@link triggersForFile} over source text — the test surface. */
export async function triggerInSource(
  source: string,
  language: Language,
  line: number,
  column: number | null
): Promise<SiteTrigger | null> {
  if (!JS_FAMILY.has(language)) return null;
  const tree = await parse(source, language);
  if (!tree) return null;
  try {
    return triggerInTree(tree.rootNode, source, line, column);
  } finally {
    tree.delete();
  }
}

export function triggerInTree(root: SyntaxNode, source: string, line: number, column: number | null): SiteTrigger | null {
  const row = line - 1;
  const col = column ?? firstNonBlankColumn(source, row);
  let node: SyntaxNode | null = innermostAt(root, row, col);
  let prev: SyntaxNode | null = null;
  // Whether the climb crossed an inline function: `onPress={() => go()}`
  // fires later, `behavior={isAndroid() ? 'a' : 'b'}` runs at render.
  let deferred = false;
  for (let up = 0; node && up < MAX_TRIGGER_CLIMB; up++, prev = node, node = node.parent) {
    const type = node.type;
    if (TRIGGER_BOUNDARIES.has(type)) return null;
    // A named handler is its own story: `const handleX = useCallback(() => …)`
    // binds a name, and whoever uses the name is the trigger of what is inside.
    if (type === 'arrow_function' || type === 'function_expression') {
      const p = node.parent;
      if (p?.type === 'variable_declarator') return null;
      if (p?.type === 'arguments' && p.parent) {
        const callee = lastSegment(calleeText(p.parent));
        if (callee === 'useCallback' || callee === 'useMemo' || callee === 'useEffectEvent' || callee === 'useEvent') return null;
      }
      deferred = true;
    }
    if (type === 'jsx_attribute') {
      const name = node.namedChild(0);
      const propName = name ? name.text : 'prop';
      // An event prop, or any prop given a function: fired later. A value
      // computed in the attribute (`behavior={isAndroid() ? …}`) is not.
      if (!deferred && !/^on[A-Z]/.test(propName)) return null;
      const element = node.parent;
      const tag = element ? element.childForFieldName('name') : null;
      return { kind: 'prop', name: propName, of: tag ? collapseText(tag.text) : null };
    }
    if (type === 'pair') {
      const key = node.childForFieldName('key');
      const keyText = key ? key.text.replace(/^['"`]|['"`]$/g, '') : '';
      if (/^on[A-Z]\w*$/.test(keyText)) {
        // `useFormik({ onSubmit: … })`, `Alert.alert(t, m, [{ onPress: … }])`:
        // the object — possibly inside an array — is an argument of a call.
        let holder: SyntaxNode | null = node.parent;
        for (let hop = 0; holder && hop < 4 && (holder.type === 'object' || holder.type === 'array' || holder.type === 'pair'); hop++) {
          holder = holder.parent;
        }
        const call = holder?.type === 'arguments' ? holder.parent : null;
        return { kind: 'option', name: keyText, of: call && CALL_TYPES.has(call.type) ? calleeText(call) : null };
      }
    }
    if (type === 'arguments' && node.parent && CALL_TYPES.has(node.parent.type) && prev !== null) {
      const callee = lastSegment(calleeText(node.parent));
      if (callee !== null && LATER_CALLEES.has(callee)) {
        const first = node.namedChild(0);
        const of = first && STRING_TYPES.has(first.type) ? cut(collapseText(first.text), MAX_ARG_TEXT) : null;
        return { kind: 'callback', name: callee, of };
      }
    }
  }
  return null;
}

/** A call's callee as written: `nativeEmitter.addListener`, `Alert.alert`, `useFormik`. */
function calleeText(call: SyntaxNode): string | null {
  const callee = call.childForFieldName('function') ?? call.childForFieldName('constructor');
  return callee ? cut(collapseText(callee.text), 40) : null;
}

/** The last segment of a callee: `nativeEmitter.addListener` → `addListener`. */
function lastSegment(text: string | null): string | null {
  if (text === null) return null;
  const m = text.match(/([A-Za-z_$][\w$]*)\s*$/);
  return m ? m[1]! : text;
}

function collapseText(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function collapse(text: string): string {
  return collapseText(text);
}

function cut(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function firstNonBlankColumn(source: string, row: number): number {
  const line = source.split('\n')[row] ?? '';
  const m = line.match(/\S/);
  return m ? (m.index ?? 0) : 0;
}

/** Load the grammars {@link guardsForFileSync} needs; a no-op once loaded, never throws. */
export async function warmBranchGuardGrammars(only?: readonly Language[]): Promise<void> {
  const wanted = BRANCH_GUARD_LANGUAGES.filter((l) => !only || only.includes(l));
  if (wanted.length === 0) return;
  try {
    await loadGrammarsForLanguages(wanted);
  } catch {
    // Explore prints no `when` for that language; nothing else changes.
  }
}

/** Guards for one site in source text — the test seam; production reads files. */
export async function guardsInSource(
  source: string,
  language: Language,
  line: number,
  column: number | null = null
): Promise<BranchGuard[]> {
  if (!supportsBranchGuards(language)) return [];
  const tree = await parse(source, language);
  if (!tree) return [];
  try {
    return guardsInTree(tree.rootNode, source, language, line, column);
  } finally {
    tree.delete();
  }
}

/**
 * The walk. `line` is 1-based, `column` 0-based (null → first non-blank).
 * Returns the guards outermost first — execution order, the way a reader
 * would list them.
 */
export function guardsInTree(
  root: SyntaxNode,
  source: string,
  language: Language,
  line: number,
  column: number | null
): BranchGuard[] {
  const row = line - 1;
  if (row < 0) return [];
  let col = column ?? 0;
  if (column === null) {
    const text = source.split('\n')[row] ?? '';
    const first = text.search(/\S/);
    col = first < 0 ? 0 : first;
  }
  let node: SyntaxNode | null = innermostAt(root, row, col);
  if (!node) return [];
  const rules: Rules = language === 'swift' ? SWIFT : JS;
  const found: BranchGuard[] = [];

  // Innermost → outermost. `found` is reversed at the end, so within one level
  // anything meant to read as OUTER must be pushed LATER.
  while (node) {
    const parent: SyntaxNode | null = node.parent;
    if (!parent || rules.boundaries.has(parent.type)) break;
    if (rules.inlineFunctions.has(parent.type)) {
      const holder = parent.parent?.type ?? '';
      if (rules.bindingParents.has(holder)) break;
      node = parent;
      continue;
    }
    rules.enclosing(parent, node, found);
    if (rules.blocks.has(parent.type)) rules.earlyExits(parent, node, found);
    node = parent;
  }
  found.reverse();
  return found;
}

/**
 * The innermost named node containing (row, col). `descendantForPosition` is
 * the fast path, but some grammars (Swift's `statements`) answer with the
 * container, so the result is refined by descending while a named child still
 * contains the point.
 */
function innermostAt(root: SyntaxNode, row: number, col: number): SyntaxNode | null {
  let node: SyntaxNode | null = root.descendantForPosition({ row, column: col });
  if (!node) return null;
  for (;;) {
    let next: SyntaxNode | null = null;
    const here: SyntaxNode = node;
    for (let i = 0; i < here.namedChildCount; i++) {
      const c: SyntaxNode = here.namedChild(i)!;
      const s = c.startPosition;
      const e = c.endPosition;
      const afterStart = s.row < row || (s.row === row && s.column <= col);
      const beforeEnd = e.row > row || (e.row === row && e.column > col);
      if (afterStart && beforeEnd) {
        next = c;
        break;
      }
    }
    if (!next) return node;
    node = next;
  }
}

// =============================================================================
// Language rules
// =============================================================================

interface Rules {
  /**
   * Node types the walk never climbs past: the function the site belongs to.
   * An INLINE function — an arrow passed as an argument, a closure in an
   * object literal, a trailing closure — is not a boundary: the conditions
   * around its definition are the conditions under which it exists at all,
   * which is what a reader asking "when does this run" wants. A function that
   * is declared, or assigned to a name, starts its own story.
   */
  boundaries: ReadonlySet<string>;
  /** Function-expression types that are boundaries only when named/assigned. */
  inlineFunctions: ReadonlySet<string>;
  /** Parent types under which an inline function counts as named/assigned. */
  bindingParents: ReadonlySet<string>;
  /** Statement containers whose earlier children may be early exits. */
  blocks: ReadonlySet<string>;
  /** `parent` encloses `child` (the node the walk came up through): record any branch. */
  enclosing(parent: SyntaxNode, child: SyntaxNode, out: BranchGuard[]): void;
  /** `child` is a statement of block `parent`: record the exits before it. */
  earlyExits(parent: SyntaxNode, child: SyntaxNode, out: BranchGuard[]): void;
}

function condText(node: SyntaxNode | null | undefined): string {
  if (!node) return '';
  let n: SyntaxNode = node;
  // `(x)` — the parens are the statement's, not the condition's.
  while (n.type === 'parenthesized_expression' && n.namedChildCount === 1) n = n.namedChild(0)!;
  const text = n.text.replace(/\s+/g, ' ').trim();
  return text.length > MAX_TEXT ? text.slice(0, MAX_TEXT - 1) + '…' : text;
}

function guard(form: GuardForm, cond: SyntaxNode | null | undefined, negated: boolean, text?: string): BranchGuard | null {
  const t = text ?? condText(cond);
  if (!t) return null;
  return { text: t, negated, form, line: (cond ?? null) ? cond!.startPosition.row + 1 : 0 };
}

function push(out: BranchGuard[], g: BranchGuard | null): void {
  if (g) out.push(g);
}

function isField(parent: SyntaxNode, field: string, child: SyntaxNode): boolean {
  const f = parent.childForFieldName(field);
  return !!f && f.id === child.id;
}

function lastNamed(node: SyntaxNode): SyntaxNode | null {
  return node.namedChildCount > 0 ? node.namedChild(node.namedChildCount - 1) : null;
}

/** The named children of `parent` that come before `child`, in source order. */
function precedingSiblings(parent: SyntaxNode, child: SyntaxNode): SyntaxNode[] {
  const out: SyntaxNode[] = [];
  for (let i = 0; i < parent.namedChildCount; i++) {
    const s = parent.namedChild(i)!;
    if (s.id === child.id) break;
    out.push(s);
  }
  return out;
}

// ----------------------------------------------------------------------- JS --

const JS_EXITS = new Set(['return_statement', 'throw_statement', 'break_statement', 'continue_statement']);

/** A statement that always leaves the block: an exit, or a block ending in one. */
function jsAlwaysExits(node: SyntaxNode | null): boolean {
  if (!node) return false;
  if (JS_EXITS.has(node.type)) return true;
  if (node.type === 'statement_block') return jsAlwaysExits(lastNamed(node));
  return false;
}

const JS: Rules = {
  boundaries: new Set([
    'function_declaration',
    'method_definition',
    'generator_function_declaration',
    'class_declaration',
    'class_body',
    'class',
    'program',
  ]),
  inlineFunctions: new Set(['arrow_function', 'function_expression', 'function', 'generator_function']),
  bindingParents: new Set([
    'variable_declarator',
    'assignment_expression',
    'export_statement',
    'public_field_definition',
    'field_definition',
    'lexical_declaration',
  ]),
  blocks: new Set(['statement_block', 'program', 'switch_case', 'switch_default']),

  enclosing(parent, child, out) {
    switch (parent.type) {
      case 'if_statement': {
        const cond = parent.childForFieldName('condition');
        if (isField(parent, 'consequence', child)) push(out, guard('if', cond, false));
        else if (isField(parent, 'alternative', child)) push(out, guard('else', cond, true));
        return;
      }
      case 'ternary_expression': {
        const cond = parent.childForFieldName('condition');
        if (isField(parent, 'consequence', child)) push(out, guard('ternary', cond, false));
        else if (isField(parent, 'alternative', child)) push(out, guard('ternary', cond, true));
        return;
      }
      case 'switch_case':
      case 'switch_default': {
        // `child` is one of the case's body statements (not its value).
        if (parent.type === 'switch_case' && isField(parent, 'value', child)) return;
        const body = parent.parent; // switch_body
        const stmt = body?.parent; // switch_statement
        const subject = condText(stmt?.childForFieldName('value'));
        if (parent.type === 'switch_default') push(out, guard('case', stmt?.childForFieldName('value'), false, subject ? `${subject}: default` : 'default'));
        else {
          const value = condText(parent.childForFieldName('value'));
          push(out, guard('case', parent.childForFieldName('value'), false, subject ? `${subject} === ${value}` : value));
        }
        return;
      }
      case 'binary_expression': {
        if (!isField(parent, 'right', child)) return;
        const op = parent.childForFieldName('operator')?.text;
        const left = parent.childForFieldName('left');
        if (op === '&&') push(out, guard('and', left, false));
        else if (op === '||') push(out, guard('or', left, true));
        return;
      }
      case 'catch_clause':
        if (!isField(parent, 'parameter', child)) push(out, guard('catch', null, false, 'on error'));
        return;
      default:
        return;
    }
  },

  earlyExits(parent, child, out) {
    // Outer-most last (the list is reversed once at the end): walk the
    // preceding statements backwards so the FIRST guard in the source ends up
    // first in the final order.
    const before = precedingSiblings(parent, child);
    for (let i = before.length - 1; i >= 0; i--) {
      const s = before[i]!;
      if (s.type !== 'if_statement' || s.childForFieldName('alternative')) continue;
      if (!jsAlwaysExits(s.childForFieldName('consequence'))) continue;
      push(out, guard('guard', s.childForFieldName('condition'), true));
    }
  },
};

// -------------------------------------------------------------------- Swift --

function swiftAlwaysExits(node: SyntaxNode | null): boolean {
  if (!node) return false;
  if (node.type === 'control_transfer_statement') return true;
  if (node.type === 'statements') return swiftAlwaysExits(lastNamed(node));
  return false;
}

/** For a Swift `if`: is `child` after the `else` keyword? */
function afterElse(parent: SyntaxNode, child: SyntaxNode): boolean {
  let seenElse = false;
  for (let i = 0; i < parent.childCount; i++) {
    const c = parent.child(i)!;
    if (c.id === child.id) return seenElse;
    if (c.type === 'else') seenElse = true;
  }
  return false;
}

/** All `condition` fields of a Swift `if`/`guard`, joined — `if let x, y > 0`. */
function swiftConditions(node: SyntaxNode): { node: SyntaxNode | null; text: string } {
  // The grammar labels several tokens of `if let x = y, z > 0` as `condition`
  // (the binding's own pieces included), so the readable text is the SPAN from
  // the first to the last of them, not the pieces joined.
  const parts: SyntaxNode[] = [];
  for (let i = 0; i < node.childCount; i++) {
    if (node.fieldNameForChild(i) === 'condition') parts.push(node.child(i)!);
  }
  if (parts.length === 0) return { node: null, text: '' };
  const first = parts[0]!;
  const last = parts[parts.length - 1]!;
  const raw = node.text.slice(first.startIndex - node.startIndex, last.endIndex - node.startIndex);
  const text = raw.replace(/\s+/g, ' ').trim();
  return { node: first, text: text.length > MAX_TEXT ? text.slice(0, MAX_TEXT - 1) + '…' : text };
}

const SWIFT: Rules = {
  boundaries: new Set([
    'function_declaration',
    'init_declaration',
    'deinit_declaration',
    'class_declaration',
    'protocol_declaration',
    'computed_property',
    'source_file',
  ]),
  inlineFunctions: new Set(['lambda_literal']),
  bindingParents: new Set(['property_declaration', 'assignment']),
  blocks: new Set(['statements', 'function_body']),

  enclosing(parent, child, out) {
    switch (parent.type) {
      case 'if_statement': {
        const c = swiftConditions(parent);
        if (parent.fieldNameForChild(indexOf(parent, child)) === 'condition') return;
        push(out, guard(afterElse(parent, child) ? 'else' : 'if', c.node, afterElse(parent, child), c.text));
        return;
      }
      case 'guard_statement': {
        // Inside the guard's body the condition FAILED.
        if (parent.fieldNameForChild(indexOf(parent, child)) === 'condition') return;
        const c = swiftConditions(parent);
        push(out, guard('else', c.node, true, c.text));
        return;
      }
      case 'ternary_expression': {
        const cond = parent.childForFieldName('condition');
        if (isField(parent, 'if_true', child)) push(out, guard('ternary', cond, false));
        else if (isField(parent, 'if_false', child)) push(out, guard('ternary', cond, true));
        return;
      }
      case 'switch_entry': {
        const stmt = parent.parent;
        const subject = condText(stmt?.childForFieldName('expr'));
        const pattern = parent.namedChildren.find((n) => n.type === 'switch_pattern');
        if (pattern && pattern.id === child.id) return;
        const isDefault = parent.children.some((n) => n.type === 'default_keyword');
        const value = pattern ? condText(pattern) : '';
        const text = isDefault ? (subject ? `${subject}: default` : 'default') : subject ? `${subject} == ${value}` : value;
        push(out, guard('case', pattern ?? stmt?.childForFieldName('expr'), false, text));
        return;
      }
      case 'catch_block':
        push(out, guard('catch', null, false, 'on error'));
        return;
      default:
        return;
    }
  },

  earlyExits(parent, child, out) {
    const before = precedingSiblings(parent, child);
    for (let i = before.length - 1; i >= 0; i--) {
      const s = before[i]!;
      if (s.type === 'guard_statement') {
        const c = swiftConditions(s);
        push(out, guard('guard', c.node, false, c.text));
      } else if (s.type === 'if_statement' && !s.children.some((n) => n.type === 'else')) {
        const body = s.namedChildren.find((n) => n.type === 'statements') ?? null;
        if (!swiftAlwaysExits(body)) continue;
        const c = swiftConditions(s);
        push(out, guard('guard', c.node, true, c.text));
      }
    }
  },
};

function indexOf(parent: SyntaxNode, child: SyntaxNode): number {
  for (let i = 0; i < parent.childCount; i++) if (parent.child(i)!.id === child.id) return i;
  return -1;
}
