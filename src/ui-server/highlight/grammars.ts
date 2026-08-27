/**
 * Finding and reading the pruned TextMate grammars on disk.
 *
 * Shiki ships 700-odd grammars; the engine indexes 40-odd languages. The build
 * writes only the closure those 40 need — including the grammars they embed, so
 * a `.vue` file still gets its `<script lang="ts">` — into `dist/textmate/`,
 * and `@shikijs/langs` stays a devDependency that never reaches a user's disk.
 * See `scripts/prune-grammars.mjs`.
 *
 * They are located the way `db/index.ts` finds `schema.sql` and `assets.ts`
 * finds the viewer: relative to `__dirname`, never to `process.cwd()`, which is
 * whatever directory the user happened to be standing in.
 *
 * `dist/textmate`, not `dist/highlight` — `src/ui-server/highlight/` is this
 * module and tsc already owns `dist/ui-server/highlight/`. The same collision
 * that put the viewer in `dist/viewer` rather than `dist/ui`.
 */

import * as fs from 'fs';
import * as path from 'path';

/** Overrides where the grammars are read from. For tests and for packagers. */
export const TEXTMATE_PATH_ENV = 'CODEGRAPH_TEXTMATE_PATH';

/** What `scripts/prune-grammars.mjs` writes beside the grammar files. */
export interface GrammarManifest {
  /** Shiki version the grammars were pruned from — surfaced when one fails. */
  shikiVersion: string;
  /** Grammar id → the files to load, dependencies first, the grammar itself last. */
  languages: Record<string, string[]>;
}

/**
 * Candidate locations, most-specific first.
 *
 * 1. The `CODEGRAPH_TEXTMATE_PATH` override.
 * 2. `<__dirname>/../../textmate` — the shipped layout
 *    (`dist/ui-server/highlight/` → `dist/textmate/`).
 * 3. `<__dirname>/../../../dist/textmate` — running the TypeScript straight out
 *    of `src/` (vitest, tsx), where `__dirname` is `src/ui-server/highlight/`.
 */
export function grammarDirCandidates(): string[] {
  const override = process.env[TEXTMATE_PATH_ENV]?.trim();
  const candidates = [
    path.join(__dirname, '..', '..', 'textmate'),
    path.join(__dirname, '..', '..', '..', 'dist', 'textmate'),
  ];
  return override ? [path.resolve(override), ...candidates] : candidates;
}

/**
 * The grammar directory and its manifest, or null when the build did not run.
 *
 * Null is a normal outcome, not an error: a source checkout that has only had
 * `tsc` run against it has no `dist/textmate`, and the right answer there is
 * plain text, not a 500 on a request for source.
 */
export function loadManifest(): { dir: string; manifest: GrammarManifest } | null {
  for (const dir of grammarDirCandidates()) {
    try {
      const raw = fs.readFileSync(path.join(dir, 'manifest.json'), 'utf-8');
      const manifest = JSON.parse(raw) as GrammarManifest;
      if (manifest && typeof manifest === 'object' && manifest.languages) return { dir, manifest };
    } catch {
      // Not here — try the next candidate.
    }
  }
  return null;
}

/**
 * Read the grammar registrations one language needs, dependencies first.
 *
 * Shiki resolves a grammar's `embeddedLangs` against what is already in its
 * registry, so the order the manifest records matters: `vue` must arrive after
 * the `html`, `css` and `typescript` it embeds, or the embedded blocks come
 * back unhighlighted.
 */
export function readGrammarChain(dir: string, manifest: GrammarManifest, id: string): unknown[] {
  const files = manifest.languages[id];
  if (!files) return [];
  return files.map((file) => {
    const full = path.join(dir, `${file}.json`);
    return JSON.parse(fs.readFileSync(full, 'utf-8')) as unknown;
  });
}
