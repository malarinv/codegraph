/**
 * `when` on a wire edge — the branch conditions its call site sits under,
 * read from the source at request time (see `src/graph/branch-guards.ts`).
 *
 * The viewer groups a symbol's edges into relations; this annotates the edges
 * of a set of relations in one pass, parsing each file once. Files that
 * drifted since the index sync are skipped: the recorded line no longer
 * reliably points at the call, and a label at the wrong line is worse than
 * none. The pass is bounded so a hub with hundreds of callers cannot turn one
 * Symbol view into a parse of the repository.
 */

import type CodeGraph from '../../index';
import type { Language } from '../../types';
import { guardLabel, guardsForFile, siteKey, supportsBranchGuards } from '../../graph/branch-guards';
import { resolveProjectFile } from '../security';
import { findIndexedFile, hasDriftedOnDisk } from './source';
import type { WireEdge } from './wire';

/** Distinct files parsed per request, and sites labelled per request. */
const MAX_FILES = 24;
const MAX_SITES = 400;

/**
 * Wall-clock allowance for the whole pass. The Symbol view answers in under
 * 100 ms; batches are taken in order (the focal file first), and once the
 * budget is spent the remaining rails simply carry no `when`. The parsed
 * trees are cached, so the next view of the same neighbourhood is cheaper.
 */
const BUDGET_MS = 40;

export interface WhenBatch {
  /** POSIX project-relative path of the file the call sites are in. */
  file: string;
  edges: WireEdge[];
}

export async function annotateWhen(cg: CodeGraph, projectRoot: string, batches: readonly WhenBatch[]): Promise<void> {
  const byFile = new Map<string, WireEdge[]>();
  for (const batch of batches) {
    const bucket = byFile.get(batch.file);
    if (bucket) bucket.push(...batch.edges);
    else byFile.set(batch.file, [...batch.edges]);
  }
  let files = 0;
  let sites = 0;
  const started = Date.now();
  for (const [file, edges] of byFile) {
    if (files >= MAX_FILES || sites >= MAX_SITES) return;
    if (files > 0 && Date.now() - started > BUDGET_MS) return;
    const found = findIndexedFile(cg, file);
    if (!found || !supportsBranchGuards(found.record.language)) continue;
    if (hasDriftedOnDisk(projectRoot, found.storedPath, found.record)) continue;
    let abs: string;
    try {
      abs = resolveProjectFile(projectRoot, found.storedPath);
    } catch {
      continue;
    }
    const withLine = edges.filter((e) => typeof e.line === 'number' && e.line > 0);
    if (withLine.length === 0) continue;
    files++;
    sites += withLine.length;
    const guards = await guardsForFile(
      abs,
      found.record.language as Language,
      withLine.map((e) => ({ line: e.line!, column: typeof e.col === 'number' ? e.col : null }))
    );
    for (const edge of withLine) {
      const g = guards.get(siteKey({ line: edge.line!, column: typeof edge.col === 'number' ? edge.col : null }));
      const label = g ? guardLabel(g) : '';
      if (label) edge.when = label;
    }
  }
}

/**
 * A per-request reader of the conditions ONE call site sits under, for the
 * endpoints that walk chains rather than annotate rails (the Screens view's
 * transitions, the Steps view's links). Files are resolved once, drifted
 * files yield no label, and the count of sites labelled is bounded so a wide
 * walk cannot turn one request into a parse of the repository.
 */
export function createWhenReader(
  cg: CodeGraph,
  projectRoot: string,
  maxSites = 600
): (caller: { filePath: string; language: Language }, site: { line?: number; column?: number }) => Promise<string> {
  const files = new Map<string, { abs: string; language: Language } | null>();
  let sites = 0;
  return async (caller, site): Promise<string> => {
    if (!site.line || sites >= maxSites || !supportsBranchGuards(caller.language)) return '';
    const posix = caller.filePath.replace(/\\/g, '/');
    let file = files.get(posix);
    if (file === undefined) {
      file = null;
      const found = findIndexedFile(cg, posix);
      if (found && !hasDriftedOnDisk(projectRoot, found.storedPath, found.record)) {
        try {
          file = { abs: resolveProjectFile(projectRoot, found.storedPath), language: found.record.language as Language };
        } catch {
          file = null;
        }
      }
      files.set(posix, file);
    }
    if (!file) return '';
    sites++;
    const key = { line: site.line, column: typeof site.column === 'number' ? site.column : null };
    const g = (await guardsForFile(file.abs, file.language, [key])).get(siteKey(key));
    return g ? guardLabel(g) : '';
  };
}
