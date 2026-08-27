/**
 * The slice of Shiki's surface this server uses, declared locally.
 *
 * `@shikijs/core` is ESM-only and the engine compiles to CommonJS, so it is
 * loaded through the same `new Function('return import(...)')` escape hatch the
 * CLI uses for `@clack/prompts` — which means tsc never sees the import and
 * cannot type it. Rather than fight `.d.mts` resolution under
 * `module: commonjs`, the four shapes actually touched are written out here.
 * They are checked against the real package by the highlighter's tests: a
 * signature change shows up as a failing highlight, not as a silent `any`.
 */

export interface ShikiThemedToken {
  content: string;
  color?: string;
  fontStyle?: number;
}

export interface ShikiHighlighter {
  loadLanguageSync(lang: unknown): void;
  getLoadedLanguages(): string[];
  codeToTokensBase(code: string, options: { lang: string; theme: string }): ShikiThemedToken[][];
  dispose?(): void;
}

export interface ShikiCoreModule {
  createHighlighterCoreSync(options: {
    themes: unknown[];
    langs: unknown[];
    engine: unknown;
  }): ShikiHighlighter;
}

export interface ShikiJavaScriptEngineModule {
  createJavaScriptRegexEngine(options?: {
    forgiving?: boolean;
    target?: 'auto' | 'ES2025' | 'ES2024' | 'ES2018';
    cache?: Map<string, RegExp | Error> | null;
  }): unknown;
}
