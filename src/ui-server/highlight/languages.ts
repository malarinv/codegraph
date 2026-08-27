/**
 * Engine `Language` → TextMate grammar, and the closure of grammars that has
 * to ship for those to load.
 *
 * The engine indexes 40-odd languages; Shiki carries 700-odd grammars. Shipping
 * all of them would put 11 MB of JSON in the bundle to serve 40, so the build
 * prunes them (`scripts/prune-grammars.mjs`) to exactly the closure this table
 * names — which is why the table lives in its own module: the build script
 * reads the compiled `dist/ui-server/highlight/languages.js` rather than keeping
 * a second copy of the mapping that could drift from the runtime's.
 *
 * A language with no entry (or with `null`) is not an error. It renders as
 * plain text with its identifiers still split out, so the graph's call-site
 * links land exactly as they do everywhere else — highlighting is the part that
 * degrades, never the linking.
 */

import type { Language } from '../../types';

/**
 * The grammar each indexed language is read with.
 *
 * Three of these are deliberate approximations, marked below: Shiki has no
 * ColdFusion grammar, and the three CFML dialects the engine distinguishes are
 * each a close relative of something it does have. An approximate keyword set
 * is a better answer than no colouring at all, and nothing downstream depends
 * on the grammar being exact — the links come from the graph.
 */
export const LANGUAGE_GRAMMAR: Record<Language, string | null> = {
  typescript: 'typescript',
  javascript: 'javascript',
  tsx: 'tsx',
  jsx: 'jsx',
  // ArkTS is TypeScript plus HarmonyOS decorators — the TS grammar reads it.
  arkts: 'typescript',
  python: 'python',
  go: 'go',
  rust: 'rust',
  java: 'java',
  c: 'c',
  cpp: 'cpp',
  csharp: 'csharp',
  razor: 'razor',
  php: 'php',
  ruby: 'ruby',
  swift: 'swift',
  kotlin: 'kotlin',
  dart: 'dart',
  svelte: 'svelte',
  vue: 'vue',
  astro: 'astro',
  liquid: 'liquid',
  pascal: 'pascal',
  scala: 'scala',
  lua: 'lua',
  luau: 'luau',
  objc: 'objective-c',
  r: 'r',
  solidity: 'solidity',
  nix: 'nix',
  yaml: 'yaml',
  twig: 'twig',
  xml: 'xml',
  properties: 'properties',
  // Approximations — no CFML grammar exists. Tag soup reads as HTML, cfscript
  // is a JavaScript-shaped dialect, and a <cfquery> body is SQL.
  cfml: 'html',
  cfscript: 'javascript',
  cfquery: 'sql',
  cobol: 'cobol',
  vbnet: 'vb',
  erlang: 'erlang',
  terraform: 'terraform',
  // Not a language, the absence of one: a file no extractor claimed.
  unknown: null,
};

/** Every grammar the build must prune to, de-duplicated, in a stable order. */
export const REQUIRED_GRAMMARS: readonly string[] = [
  ...new Set(Object.values(LANGUAGE_GRAMMAR).filter((id): id is string => id !== null)),
].sort();

/**
 * The grammar for an indexed language, or null when it has none.
 *
 * Accepts the raw string off a `FileRecord` rather than a `Language`, because
 * an index written by an older engine can hold a language this build has since
 * renamed, and a viewer must not throw over that.
 */
export function grammarFor(language: string | undefined | null): string | null {
  if (!language) return null;
  return LANGUAGE_GRAMMAR[language as Language] ?? null;
}
