/**
 * Near-monochrome tokenising for the code block (design spec §2.2).
 *
 * The colouring is deliberately almost absent: comments and strings recede,
 * keywords carry weight rather than hue, and the ONLY colour in the body is a
 * resolved call site. That is the point of the screen — the graph's edges are
 * what the eye should find, and a six-colour syntax theme buries them.
 *
 * A hand-rolled lexer, not a highlighter library. It has one job — separate
 * comments, strings, numbers and keywords from everything else, well enough to
 * be honest across the 30-odd languages the engine indexes — and doing it here
 * keeps the viewer free of a runtime dependency and of a per-grammar download
 * on a machine that is reading its own source offline. CG-43 replaces this
 * with Shiki tokens produced server-side; `tokenize` is the seam.
 */

export type TokenClass =
  | 'comment'
  | 'string'
  | 'keyword'
  | 'number'
  | 'ident'
  | 'space'
  | 'punct';

export interface Token {
  cls: TokenClass;
  text: string;
  /** Column of the token's first character, 0-based — how a ref finds its identifier. */
  col: number;
}

/**
 * Lexer state that survives from one line to the next: a block comment or a
 * multi-line string opened on an earlier line. Rendering a window of a file
 * without this makes the first line after a `/*` look like code.
 */
export interface LexState {
  block: boolean;
  /** The delimiter that will close the open multi-line string (a backtick, `"""`, …). */
  stringEnd: string | null;
}

export function newLexState(): LexState {
  return { block: false, stringEnd: null };
}

/* --------------------------------------------------------------- dialects -- */

interface Dialect {
  lineComment: string[];
  blockComment: [string, string] | null;
  /** Quote characters that never span lines. */
  quotes: string[];
  /** Delimiters that MAY span lines (template literals, triple quotes, heredoc-ish). */
  multiline: string[];
  keywords: ReadonlySet<string>;
}

const kw = (words: string): ReadonlySet<string> => new Set(words.split(/\s+/).filter(Boolean));

/**
 * Keywords shared widely enough across the C-family that listing them once is
 * both shorter and more accurate than a per-language table nobody maintains.
 */
const C_FAMILY = `
  abstract as async await break case catch class const constexpr continue default defer delete do
  else enum export extends extern false final finally for from func function go goto if impl implements
  import in instanceof interface internal is let match mod module mut namespace new nil null object
  operator out override package private protected public readonly record ref return sealed select self
  static struct super switch this throw throws trait true try type typedef typeof union unsafe use using
  var virtual void when where while with yield
`;

const DIALECTS: Record<string, Dialect> = {
  c: {
    lineComment: ['//'],
    blockComment: ['/*', '*/'],
    quotes: ['"', "'"],
    multiline: [],
    keywords: kw(C_FAMILY),
  },
  ts: {
    lineComment: ['//'],
    blockComment: ['/*', '*/'],
    quotes: ['"', "'"],
    multiline: ['`'],
    keywords: kw(
      `${C_FAMILY} any asserts bigint boolean declare infer keyof never number readonly satisfies
       string symbol undefined unknown`
    ),
  },
  hash: {
    // Python, Ruby, shell, YAML, Nix, Terraform, Perl, R, Elixir…
    lineComment: ['#'],
    blockComment: null,
    quotes: ['"', "'"],
    multiline: ['"""', "'''"],
    keywords: kw(
      `and as assert async await begin break case class def defp defmodule del do elif else elsif end
       ensure except exec finally for from global if import in is lambda let module next nil none not
       or pass raise require rescue return self struct then trait true false try unless until use when
       while with yield`
    ),
  },
  sql: {
    lineComment: ['--'],
    blockComment: ['/*', '*/'],
    quotes: ["'", '"'],
    multiline: [],
    keywords: kw(
      `select insert update delete from where group by order having join left right inner outer on as
       and or not null create table index view primary key foreign references into values set limit`
    ),
  },
  lisp: {
    lineComment: [';'],
    blockComment: null,
    quotes: ['"'],
    multiline: [],
    keywords: kw('def defn defmacro let fn if cond do loop recur ns require import when case'),
  },
};

/** Engine `Language` values → the lexer that reads them closely enough. */
const LANGUAGE_DIALECT: Record<string, keyof typeof DIALECTS> = {
  typescript: 'ts',
  tsx: 'ts',
  javascript: 'ts',
  jsx: 'ts',
  svelte: 'ts',
  vue: 'ts',
  astro: 'ts',
  dart: 'c',
  java: 'c',
  kotlin: 'c',
  scala: 'c',
  csharp: 'c',
  vbnet: 'hash',
  go: 'c',
  rust: 'c',
  swift: 'c',
  objc: 'c',
  c: 'c',
  cpp: 'c',
  cuda: 'c',
  metal: 'c',
  php: 'c',
  zig: 'c',
  solidity: 'c',
  glsl: 'c',
  python: 'hash',
  ruby: 'hash',
  crystal: 'hash',
  elixir: 'hash',
  perl: 'hash',
  r: 'hash',
  shell: 'hash',
  bash: 'hash',
  powershell: 'hash',
  yaml: 'hash',
  toml: 'hash',
  nix: 'hash',
  terraform: 'hash',
  hcl: 'hash',
  dockerfile: 'hash',
  makefile: 'hash',
  sql: 'sql',
  clojure: 'lisp',
  lisp: 'lisp',
  scheme: 'lisp',
  elm: 'ts',
  haskell: 'ts',
  lua: 'hash',
  erlang: 'hash',
  cobol: 'hash',
};

function dialectFor(language: string | undefined): Dialect {
  const key = LANGUAGE_DIALECT[(language ?? '').toLowerCase()] ?? 'ts';
  return DIALECTS[key] as Dialect;
}

/* ----------------------------------------------------------------- lexer -- */

const IDENT_START = /[A-Za-z_$@]/;
const IDENT_BODY = /[\w$]/;

/**
 * Split one line into tokens, carrying `state` across lines.
 *
 * Mutates `state` — a window of source is tokenised line by line in order, and
 * threading the block-comment flag through a return value would make every
 * caller responsible for a detail only this function understands.
 */
export function tokenize(line: string, state: LexState, language?: string): Token[] {
  const d = dialectFor(language);
  const out: Token[] = [];
  const len = line.length;
  let i = 0;

  const push = (cls: TokenClass, from: number, to: number): void => {
    if (to > from) out.push({ cls, text: line.slice(from, to), col: from });
  };

  while (i < len) {
    // --- continuations of something opened on an earlier line ---------------
    if (state.block && d.blockComment) {
      const close = line.indexOf(d.blockComment[1], i);
      if (close < 0) {
        push('comment', i, len);
        i = len;
      } else {
        push('comment', i, close + d.blockComment[1].length);
        i = close + d.blockComment[1].length;
        state.block = false;
      }
      continue;
    }
    if (state.stringEnd) {
      const end = findUnescaped(line, state.stringEnd, i);
      if (end < 0) {
        push('string', i, len);
        i = len;
      } else {
        push('string', i, end + state.stringEnd.length);
        i = end + state.stringEnd.length;
        state.stringEnd = null;
      }
      continue;
    }

    const rest = line.slice(i);

    // --- comments -----------------------------------------------------------
    const lineMarker = d.lineComment.find((m) => rest.startsWith(m));
    if (lineMarker) {
      push('comment', i, len);
      i = len;
      continue;
    }
    if (d.blockComment && rest.startsWith(d.blockComment[0])) {
      const close = line.indexOf(d.blockComment[1], i + d.blockComment[0].length);
      if (close < 0) {
        push('comment', i, len);
        i = len;
        state.block = true;
      } else {
        push('comment', i, close + d.blockComment[1].length);
        i = close + d.blockComment[1].length;
      }
      continue;
    }

    // --- strings ------------------------------------------------------------
    // Longest delimiter first, so `"""` never matches as `"`.
    const multi = [...d.multiline].sort((a, b) => b.length - a.length).find((m) => rest.startsWith(m));
    if (multi) {
      const end = findUnescaped(line, multi, i + multi.length);
      if (end < 0) {
        push('string', i, len);
        i = len;
        state.stringEnd = multi;
      } else {
        push('string', i, end + multi.length);
        i = end + multi.length;
      }
      continue;
    }
    const quote = d.quotes.find((q) => rest.startsWith(q));
    if (quote) {
      const end = findUnescaped(line, quote, i + quote.length);
      // An unterminated single-line quote is an apostrophe in prose far more
      // often than a real string, so it stops at the line rather than eating
      // the rest of the window.
      push('string', i, end < 0 ? len : end + quote.length);
      i = end < 0 ? len : end + quote.length;
      continue;
    }

    // --- words, numbers, space, everything else -----------------------------
    const ch = line[i] as string;
    if (IDENT_START.test(ch)) {
      let j = i + 1;
      while (j < len && IDENT_BODY.test(line[j] as string)) j++;
      const word = line.slice(i, j);
      push(d.keywords.has(word) ? 'keyword' : 'ident', i, j);
      i = j;
      continue;
    }
    if (ch >= '0' && ch <= '9') {
      let j = i + 1;
      while (j < len && /[\w.]/.test(line[j] as string)) j++;
      push('number', i, j);
      i = j;
      continue;
    }
    if (/\s/.test(ch)) {
      let j = i + 1;
      while (j < len && /\s/.test(line[j] as string)) j++;
      push('space', i, j);
      i = j;
      continue;
    }
    push('punct', i, i + 1);
    i++;
  }

  return out;
}

/** Index of `needle` at or after `from`, skipping backslash-escaped ones. */
function findUnescaped(line: string, needle: string, from: number): number {
  let i = from;
  while (i < line.length) {
    if (line[i] === '\\') {
      i += 2;
      continue;
    }
    if (line.startsWith(needle, i)) return i;
    i++;
  }
  return -1;
}

/** The CSS class for a token, or null where the default ink is right. */
export function tokenClass(cls: TokenClass): string | null {
  switch (cls) {
    case 'comment':
      return 't-c';
    case 'string':
      return 't-s';
    case 'keyword':
      return 't-k';
    case 'number':
      return 't-n';
    default:
      return null;
  }
}
