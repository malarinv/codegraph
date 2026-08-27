/**
 * `GET /api/stats` — what this index is, and how much to trust it.
 *
 * The viewer's top bar shows a couple of numbers from here, but the reason the
 * endpoint carries more than that is honesty: an index can be truncated
 * (`state: "indexing"` after a killed run), built by an older extractor, or
 * simply old. A reader that draws confident graphs over a half-built index is
 * the failure mode worth designing against, so the state travels with the
 * counts rather than being something the UI has to ask for separately.
 */

import * as path from 'path';
import type { CodeGraph } from '../../index';
import { HUB_THRESHOLD, UNCERTAIN_BELOW } from './wire';

export function buildStats(cg: CodeGraph, projectRoot: string): unknown {
  const stats = cg.getStats();
  const build = cg.getIndexBuildInfo();

  return {
    project: {
      root: projectRoot,
      name: path.basename(projectRoot) || projectRoot,
    },
    index: {
      /**
       * `complete` is the only good value. `indexing` means a run was killed
       * part-way and the graph on disk is a truncated one; `partial`/`failed`
       * mean the run finished but dropped files. `null` predates the marker.
       */
      state: cg.getIndexState(),
      lastIndexedAt: cg.getLastIndexedAt(),
      /** Built by an older extractor — a re-index would add data no migration can. */
      stale: cg.isIndexStale(),
      version: build.version,
      extractionVersion: build.extractionVersion,
      backend: cg.getBackend(),
      journalMode: cg.getJournalMode(),
      /** References still waiting to resolve; > 0 means edges are still missing. */
      pendingReferences: cg.getPendingReferenceCount(),
      generatedFiles: cg.getGeneratedFileCount(),
      watching: cg.isWatching(),
      watcherDegraded: cg.isWatcherDegraded(),
    },
    graph: {
      nodes: stats.nodeCount,
      edges: stats.edgeCount,
      files: stats.fileCount,
      nodesByKind: stats.nodesByKind,
      edgesByKind: stats.edgesByKind,
      filesByLanguage: stats.filesByLanguage,
      dbSizeBytes: stats.dbSizeBytes,
      walSizeBytes: stats.walSizeBytes,
    },
    frameworks: cg.getDetectedFrameworks(),
    /**
     * The thresholds the API itself applied, so the viewer's copy ("hub · N",
     * "confidence < 0.6") stays in step with the data instead of hard-coding a
     * second copy of the same numbers.
     */
    thresholds: { hub: HUB_THRESHOLD, uncertainBelow: UNCERTAIN_BELOW },
  };
}
