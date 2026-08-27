/**
 * The viewer's server-side syntax classification (CG-43).
 *
 * Two things are worth pinning here and they are not the colours. The first is
 * that a call-site link lands on the callee's own name — the accent underline
 * is the only colour in the code block, and putting it on the receiver or on a
 * word inside a comment is worse than not drawing it. The second is that
 * highlighting never becomes a way for a source request to fail: a missing
 * grammar, an oversized slice, a language nobody wrote a grammar for all have
 * to answer with the source and an honest `engine: 'plain'`.
 *
 * The end-to-end shape is deliberate: the server's tokens are fed straight
 * through the viewer's own `decodeLine` and `assignRefs`, because the seam
 * between "how a grammar chose to cut a line" and "which token the overlay
 * claims" is exactly where this breaks.
 */

import { describe, it, expect, beforeAll, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  clearHighlightCache,
  grammarFor,
  highlightCacheStats,
  highlightLines,
  LANGUAGE_GRAMMAR,
  MAX_HIGHLIGHT_CHARS,
  REQUIRED_GRAMMARS,
  SLICE_CACHE_LINES,
  TOKEN_CLASSES,
  type HighlightResult,
} from '../src/ui-server/highlight';
import { loadManifest } from '../src/ui-server/highlight/grammars';
import { LANGUAGES } from '../src/types';
import { decodeLine, type Token } from '../ui/src/lib/highlight';
import { assignRefs, type LineRef } from '../ui/src/lib/symbol-model';

/**
 * The pruned grammars live in `dist/textmate`, written by `npm run build`. A
 * source tree that has only ever been type-checked has none, and the right
 * behaviour there is plain text — which is itself asserted below, so the
 * grammar-dependent cases skip rather than fail.
 */
const HAS_GRAMMARS = loadManifest() !== null;
const withGrammars = HAS_GRAMMARS ? it : it.skip;

function tokensOf(result: HighlightResult, line: number): Token[] {
  return decodeLine(result.lines[line] ?? [], result.classes);
}

/** What the code block would render for one line: `class:text` per token. */
function shape(result: HighlightResult, line: number): string[] {
  return tokensOf(result, line).map((t) => `${t.cls}:${t.text}`);
}

function lineRef(over: Partial<LineRef>): LineRef {
  return {
    ident: 'x',
    col: null,
    targetId: 'method:x',
    uncertain: false,
    outside: false,
    title: '',
    ...over,
  };
}

/** Which token an overlay ref claims — the whole point of the atomisation. */
function claimedText(result: HighlightResult, line: number, ref: LineRef): string | undefined {
  const tokens = tokensOf(result, line);
  const claimed = assignRefs(tokens, [ref]);
  const [index] = [...claimed.keys()];
  return index === undefined ? undefined : tokens[index]?.text;
}

describe('the language table', () => {
  it('has an entry for every language the engine indexes', () => {
    for (const language of LANGUAGES) {
      expect(LANGUAGE_GRAMMAR).toHaveProperty(language);
    }
  });

  it('answers null rather than throwing for a language this build never heard of', () => {
    expect(grammarFor('some-future-language')).toBeNull();
    expect(grammarFor(undefined)).toBeNull();
    expect(grammarFor('')).toBeNull();
  });

  withGrammars('ships a grammar for every id the table names', () => {
    const found = loadManifest();
    expect(found).not.toBeNull();
    for (const id of REQUIRED_GRAMMARS) {
      expect(Object.keys((found as NonNullable<typeof found>).manifest.languages)).toContain(id);
    }
  });

  withGrammars('loads a grammar chain dependencies-first, so embedded blocks highlight', () => {
    const found = loadManifest();
    const vue = (found as NonNullable<typeof found>).manifest.languages['vue'] ?? [];
    // The single-file component's own grammar is last; everything it embeds
    // has to be registered before Shiki resolves `embeddedLangs`.
    expect(vue[vue.length - 1]).toBe('vue');
    expect(vue).toContain('typescript');
    expect(vue.indexOf('typescript')).toBeLessThan(vue.length - 1);
  });
});

describe('classification', () => {
  beforeAll(() => clearHighlightCache());

  withGrammars('reads TypeScript with the four classes the theme paints', async () => {
    const result = await highlightLines(['const answer = 42; // note'], {
      language: 'typescript',
    });
    expect(result.engine).toBe('shiki');
    expect(result.grammar).toBe('typescript');
    expect(result.classes).toEqual([...TOKEN_CLASSES]);
    const rendered = shape(result, 0);
    expect(rendered).toContain('keyword:const');
    expect(rendered).toContain('ident:answer');
    expect(rendered).toContain('number:42');
    expect(rendered).toContain('comment:// note');
  });

  withGrammars('reads a # comment as a comment in Python and as code in TypeScript', async () => {
    const python = await highlightLines(['x = 1  # note'], { language: 'python' });
    expect(shape(python, 0).at(-1)).toBe('comment:# note');

    const ts = await highlightLines(['x = 1  # note'], { language: 'typescript' });
    expect(shape(ts, 0).at(-1)).not.toBe('comment:# note');
  });

  withGrammars('carries a block comment across lines within one slice', async () => {
    const result = await highlightLines(['/* open', 'still comment', 'done */ const x = 1;'], {
      language: 'typescript',
    });
    expect(shape(result, 1)).toEqual(['comment:still comment']);
    expect(shape(result, 2)[0]).toBe('comment:done */');
    expect(shape(result, 2)).toContain('keyword:const');
  });

  withGrammars('reads Go, which has its own idea of what a keyword is', async () => {
    const result = await highlightLines(['func Greet(name string) string {'], { language: 'go' });
    expect(shape(result, 0)).toContain('keyword:func');
    expect(shape(result, 0)).toContain('ident:Greet');
  });

  withGrammars('reads ArkTS with the TypeScript grammar', async () => {
    const result = await highlightLines(['@Entry struct Index { build() {} }'], {
      language: 'arkts',
    });
    expect(result.engine).toBe('shiki');
    expect(result.grammar).toBe('typescript');
  });

  withGrammars('emits one entry per source line, always', async () => {
    const lines = ['a();', '', 'b();', ''];
    const result = await highlightLines(lines, { language: 'typescript' });
    // The code block indexes rows positionally: one short answer and every
    // line below it renders the wrong source.
    expect(result.lines).toHaveLength(lines.length);
    expect(result.lines[1]).toEqual([]);
  });
});

describe('the plain fallback', () => {
  beforeAll(() => clearHighlightCache());

  it('answers plain, with a reason, for a language no grammar covers', async () => {
    const result = await highlightLines(['whatever this is'], { language: 'unknown' });
    expect(result.engine).toBe('plain');
    expect(result.grammar).toBeNull();
    expect(result.reason).toBeTruthy();
    expect(result.lines).toHaveLength(1);
  });

  it('still splits identifiers when it cannot highlight, so the links land', async () => {
    const result = await highlightLines(['  return this.mutex.withLock();'], {
      language: 'unknown',
    });
    expect(claimedText(result, 0, lineRef({ ident: 'withLock', col: 9 }))).toBe('withLock');
  });

  it('refuses to tokenise a minified line rather than wedging on it', async () => {
    const enormous = 'a'.repeat(MAX_HIGHLIGHT_CHARS + 1);
    const result = await highlightLines([enormous], { language: 'javascript' });
    expect(result.engine).toBe('plain');
    expect(result.reason).toMatch(/minified/);
    // The source still comes back whole — that is the part that matters.
    expect(result.lines[0]?.map(([, text]) => text).join('')).toHaveLength(enormous.length);
  });

  it('answers plain when a shipped grammar file is missing or unreadable', async () => {
    // The install is half there: a manifest that names a grammar whose file
    // never made it. The viewer must still get its source.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-textmate-'));
    fs.writeFileSync(
      path.join(dir, 'manifest.json'),
      JSON.stringify({ shikiVersion: 'test', languages: { typescript: ['typescript'] } })
    );

    const previous = process.env.CODEGRAPH_TEXTMATE_PATH;
    process.env.CODEGRAPH_TEXTMATE_PATH = dir;
    // A fresh module registry: the highlighter and its grammar bookkeeping are
    // created once per process, and this case is about that first attempt.
    vi.resetModules();
    try {
      const mod = await import('../src/ui-server/highlight');
      const result: HighlightResult = await mod.highlightLines(['const x = 1;'], {
        language: 'typescript',
      });
      expect(result.engine).toBe('plain');
      expect(result.reason).toBeTruthy();
      expect(result.lines[0]?.map(([, text]) => text).join('')).toBe('const x = 1;');
    } finally {
      if (previous === undefined) delete process.env.CODEGRAPH_TEXTMATE_PATH;
      else process.env.CODEGRAPH_TEXTMATE_PATH = previous;
      fs.rmSync(dir, { recursive: true, force: true });
      vi.resetModules();
    }
  });
});

describe('graph links land on the right token', () => {
  beforeAll(() => clearHighlightCache());

  withGrammars('marks the callee, not the receiver the recorded column points at', async () => {
    // The recorded column is the start of the calling EXPRESSION — `this` —
    // and the underline has to end up on `withLock`.
    const line = '    return this.indexMutex.withLock(async () => {';
    const result = await highlightLines([line], { language: 'typescript' });
    expect(claimedText(result, 0, lineRef({ ident: 'withLock', col: line.indexOf('this') }))).toBe(
      'withLock'
    );
  });

  withGrammars('lands on a real call site in the engine’s own src/index.ts', async () => {
    const file = path.join(__dirname, '..', 'src', 'index.ts');
    const source = fs.readFileSync(file, 'utf-8').split('\n');
    // A line the engine actually contains, found rather than hard-coded, so a
    // refactor of index.ts retires this test instead of silently passing.
    const index = source.findIndex((l) => /^\s*(?:return |const \w+ = )?this\.\w+\.\w+\(/.test(l));
    expect(index).toBeGreaterThanOrEqual(0);
    const line = source[index] as string;
    const match = /this\.(\w+)\.(\w+)\(/.exec(line) as RegExpExecArray;
    const callee = match[2] as string;

    const result = await highlightLines([line], { language: 'typescript' });
    expect(claimedText(result, 0, lineRef({ ident: callee, col: line.indexOf('this') }))).toBe(
      callee
    );
  });

  withGrammars('lands on a Go method call', async () => {
    const line = '\tresult := s.repo.FindByID(ctx, id)';
    const result = await highlightLines([line], { language: 'go' });
    expect(claimedText(result, 0, lineRef({ ident: 'FindByID', col: line.indexOf('s.repo') }))).toBe(
      'FindByID'
    );
  });

  withGrammars('lands on a Python method call, not on the receiver of the same name', async () => {
    const line = '    return self.store.join(self.store.path)';
    const result = await highlightLines([line], { language: 'python' });
    expect(claimedText(result, 0, lineRef({ ident: 'join', col: line.indexOf('self') }))).toBe(
      'join'
    );
  });

  withGrammars('leaves a word inside a comment or a string alone', async () => {
    const result = await highlightLines(
      ['  // call render here', '  const s = "render";'],
      { language: 'typescript' }
    );
    expect(claimedText(result, 0, lineRef({ ident: 'render' }))).toBeUndefined();
    expect(claimedText(result, 1, lineRef({ ident: 'render' }))).toBeUndefined();
  });

  withGrammars('keeps every identifier separately claimable', async () => {
    const result = await highlightLines(['render(); render();'], { language: 'typescript' });
    const tokens = tokensOf(result, 0);
    const claimed = assignRefs(tokens, [
      lineRef({ ident: 'render', targetId: 'a' }),
      lineRef({ ident: 'render', targetId: 'b' }),
    ]);
    expect(claimed.size).toBe(2);
  });

  withGrammars('reproduces the line exactly — the code block renders these tokens', async () => {
    const line = '  const s = `a ${b.c()} d`; // 1 + 2';
    const result = await highlightLines([line], { language: 'typescript' });
    expect(
      tokensOf(result, 0)
        .map((t) => t.text)
        .join('')
    ).toBe(line);
  });
});

describe('cost', () => {
  withGrammars('answers a cached slice without re-tokenising it', async () => {
    clearHighlightCache();
    const lines = fs
      .readFileSync(path.join(__dirname, '..', 'src', 'ui-server', 'api', 'source.ts'), 'utf-8')
      .split('\n');

    const cold = Date.now();
    await highlightLines(lines, { language: 'typescript', cacheKey: 'a:1:9999' });
    const coldMs = Date.now() - cold;

    const warm = Date.now();
    const second = await highlightLines(lines, { language: 'typescript', cacheKey: 'a:1:9999' });
    const warmMs = Date.now() - warm;

    expect(second.engine).toBe('shiki');
    // The cache is what makes a re-render free: every resize, theme flip and
    // step back through the trail re-asks for the same slice.
    expect(warmMs).toBeLessThan(Math.max(20, coldMs / 4));
  });

  it('bounds the cache by total lines, not just by entry count', async () => {
    clearHighlightCache();
    const big = new Array(Math.ceil(SLICE_CACHE_LINES / 2) + 10).fill('x');
    // The entry count alone would let a reader left open on a big repo grow
    // without limit: three of these is well inside SLICE_CACHE_LIMIT and well
    // over the line budget.
    for (const key of ['one', 'two', 'three']) {
      await highlightLines(big, { language: 'unknown', cacheKey: key });
    }
    const stats = highlightCacheStats();
    expect(stats.entries).toBeLessThan(3);
    expect(stats.lines).toBeLessThanOrEqual(SLICE_CACHE_LINES);
  });

  withGrammars('keys the cache on the content, so an edited file re-highlights', async () => {
    clearHighlightCache();
    const first = await highlightLines(['const a = 1;'], {
      language: 'typescript',
      cacheKey: 'hash-one:1:1',
    });
    const second = await highlightLines(['const bbb = 2;'], {
      language: 'typescript',
      cacheKey: 'hash-two:1:1',
    });
    expect(first.lines[0]?.map(([, t]) => t).join('')).toBe('const a = 1;');
    expect(second.lines[0]?.map(([, t]) => t).join('')).toBe('const bbb = 2;');
  });
});
