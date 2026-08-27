/**
 * `GET /api/source?file=&from=&to=` — verbatim source, or an honest refusal.
 *
 * This is the one endpoint that reads the user's repository, so two rules
 * govern it and neither is negotiable.
 *
 * **Every read goes through `resolveProjectFile`.** That is the chokepoint from
 * `security.ts` — traversal, in-tree symlinks pointing out of the root,
 * absolute paths, sensitive system directories. Without it,
 * `?file=../../.ssh/id_rsa` is a credential leak over a port the user opened to
 * read their own code.
 *
 * **A file that changed on disk since it was indexed is never sliced.** The
 * viewer asks for line ranges the *index* recorded; if the file moved on since,
 * those ranges can point at a different symbol's body, which would be served
 * under the requested name and look perfectly plausible. So the bytes are
 * hashed and compared against `files.content_hash`, and on a mismatch the slice
 * is omitted with `drift: true` — the same call `codegraph_node` makes when it
 * says "changed on disk after the last index sync".
 *
 * Only files that are IN the index are served. That is a tighter boundary than
 * the MCP tools take, and it costs the viewer nothing (it only ever renders
 * indexed symbols) while making the drift verdict meaningful for every answer:
 * there is always a hash to compare against.
 */

import { createHash } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import type { FileRecord } from '../../types';
import type { CodeGraph } from '../../index';
import { resolveProjectFile } from '../security';
import { highlightLines, type HighlightResult } from '../highlight';
import { ApiError, badRequest, intParam, notFound, textParam } from './respond';

/**
 * Largest file we will read to answer a source request.
 *
 * The whole file has to be read to hash it, so this bounds the work one request
 * can cause. Well above the 1 MB ceiling extraction itself applies, so anything
 * actually in the index is comfortably inside it.
 */
export const MAX_SOURCE_BYTES = 8 * 1024 * 1024;

/** Lines returned in one response. The Symbol view asks for windows, not files. */
export const MAX_SOURCE_LINES = 4000;

/**
 * Look up a file record by a viewer-supplied path, WITHOUT validating it.
 *
 * Indexed paths are normalized to forward slashes at extraction time, so that
 * is the form tried first; the platform-separator form is a fallback for an
 * index written before that normalization.
 *
 * Callers that go on to READ the file must use {@link resolveRequestedFile}
 * instead — it puts the path through the security chokepoint first. This one is
 * for endpoints that only need the record (a drift flag on a path the index
 * itself handed us).
 */
export function findIndexedFile(
  cg: CodeGraph,
  requested: string
): { record: FileRecord; storedPath: string } | null {
  const posix = toRequestPath(requested);
  const record = cg.getFile(posix);
  if (record) return { record, storedPath: posix };

  const native = posix.split('/').join(path.sep);
  if (native !== posix) {
    const legacy = cg.getFile(native);
    if (legacy) return { record: legacy, storedPath: native };
  }
  return null;
}

/**
 * Forward slashes and no leading `./` — the form indexed paths are stored in.
 *
 * A LEADING SLASH IS LEFT ALONE on purpose. Stripping it would quietly turn
 * `/etc/passwd` into the project-relative `etc/passwd` and answer "not in this
 * index" — reinterpreting the request instead of refusing it, and leaving the
 * chokepoint's absolute-path rule with nothing to catch.
 */
export function toRequestPath(requested: string): string {
  return requested.replace(/\\/g, '/').replace(/^\.\//, '');
}

/**
 * Validate a viewer-supplied path, THEN look it up in the index.
 *
 * The order is the point. `resolveProjectFile` runs first, so a traversal, an
 * absolute path or a sensitive system directory is refused as what it is,
 * before the index is consulted — a 403 that says "outside the project", not a
 * 404 that says "not indexed" and quietly depends on the index lookup missing.
 * It also means the absolute path every reader uses has already been through
 * the chokepoint by construction, rather than by remembering to call it.
 *
 * @throws {PathRefusalError} the path is not one we would ever read.
 * @throws {ApiError} `not-found` when it is fine but not in the index.
 */
export function resolveRequestedFile(
  cg: CodeGraph,
  projectRoot: string,
  requested: string
): { record: FileRecord; storedPath: string; absolute: string } {
  const posix = toRequestPath(requested);
  // Refusals happen here, ahead of everything.
  const absolute = resolveProjectFile(projectRoot, posix);

  const found = findIndexedFile(cg, posix);
  if (!found) throw notIndexedError(posix);
  return { ...found, absolute };
}

export function notIndexedError(file: string): ApiError {
  return notFound(
    `${file} is not in this CodeGraph index.`,
    'The viewer only reads files the index knows about. If the file is new, ' +
      'it appears after the next sync; if it is excluded (gitignored, generated, ' +
      'or too large to parse), it will not appear at all.'
  );
}

/**
 * Split source the way the index counted it.
 *
 * Rows are `\n`-delimited — that is how tree-sitter numbers them — so a CRLF
 * file has the same line numbers here as in the graph. The trailing `\r` is
 * dropped per line so it does not render as a stray glyph.
 */
export function splitLines(content: string): string[] {
  const lines = content.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] as string;
    if (line.endsWith('\r')) lines[i] = line.slice(0, -1);
  }
  // A file ending in a newline splits to a final empty string that is not a
  // line of source. Every other trailing empty line IS one.
  if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop();
  return lines;
}

/**
 * Whether an indexed file has changed on disk since it was indexed — the same
 * verdict `/api/source` returns, for endpoints that must *flag* drift without
 * serving source (a symbol header, a file outline).
 *
 * Cheap first: size plus floored mtime is the identical freshness test the sync
 * fast path uses, so an untouched file costs one `stat`. Only a stat mismatch
 * pays for a hash, which is what keeps a `touch` or a checkout that rewrote
 * identical bytes from reading as drift.
 *
 * Any failure answers `false`. A wrong "stale" flag would put a warning banner
 * over correct source; the cases that would trip it (missing record, unreadable
 * file) have their own handling in the endpoints that actually read.
 */
export function hasDriftedOnDisk(
  projectRoot: string,
  storedPath: string,
  record: FileRecord
): boolean {
  try {
    const absolute = resolveProjectFile(projectRoot, storedPath);
    const stats = fs.statSync(absolute);
    if (stats.size === record.size && Math.floor(stats.mtimeMs) === Math.floor(record.modifiedAt)) {
      return false;
    }
    if (stats.size > MAX_SOURCE_BYTES) return true;
    const content = fs.readFileSync(absolute, 'utf-8');
    return createHash('sha256').update(content).digest('hex') !== record.contentHash;
  } catch {
    return false;
  }
}

/**
 * The drift verdict AND the file's length, from one read.
 *
 * The whole-file view needs both before it draws anything: the drift banner,
 * and the line count that fixes the height of the scrolling document (every
 * line is a fixed 20px, so the total IS the layout). Asking
 * {@link hasDriftedOnDisk} and then a source page would answer the first
 * question against one read of the file and the second against another, which
 * is exactly the window in which a file can change underneath the two.
 *
 * Unlike `hasDriftedOnDisk` there is no stat-only fast path: the bytes have to
 * be read to be counted. That is the cost of knowing the length, and it is
 * bounded by {@link MAX_SOURCE_BYTES} like every other read here.
 */
export function readFileShape(
  projectRoot: string,
  storedPath: string,
  record: FileRecord
): { drift: boolean; totalLines: number | null; reason?: string } {
  let absolute: string;
  try {
    absolute = resolveProjectFile(projectRoot, storedPath);
  } catch {
    // A refusal on a path the INDEX handed us is not a request to refuse — the
    // caller already passed the chokepoint. Treat it as unreadable.
    return { drift: false, totalLines: null };
  }
  try {
    const stats = fs.statSync(absolute);
    if (stats.size > MAX_SOURCE_BYTES) {
      return { drift: false, totalLines: null, reason: 'The file is too large to read here.' };
    }
    const content = fs.readFileSync(absolute, 'utf-8');
    const drift = createHash('sha256').update(content).digest('hex') !== record.contentHash;
    return {
      drift,
      totalLines: splitLines(content).length,
      ...(drift
        ? {
            reason:
              'This file changed on disk after the last index sync, so the line ' +
              'numbers the graph holds no longer match it.',
          }
        : {}),
    };
  } catch {
    return {
      drift: true,
      totalLines: null,
      reason: 'The file is in the index but could not be read from disk.',
    };
  }
}

export interface SourceResult {
  file: string;
  language: string;
  /** The file on disk differs from what was indexed — no slice is served. */
  drift: boolean;
  contentHash: string;
  indexedAt: number;
  generated: boolean;
  totalLines: number | null;
  from?: number;
  to?: number;
  lines?: string[];
  truncated?: boolean;
  reason?: string;
  /**
   * The same lines, classified for the code block — one entry per line, each a
   * list of `[classId, text]` pairs indexed into `highlight.classes`.
   *
   * It rides with the slice rather than living behind its own endpoint because
   * the two are only ever wanted together, and because a second round-trip
   * would let the viewer paint unhighlighted source and then reflow it. Absent
   * whenever `lines` is — a drifted file is not served at all.
   */
  highlight?: HighlightResult;
}

export async function buildSource(
  cg: CodeGraph,
  projectRoot: string,
  query: URLSearchParams
): Promise<SourceResult> {
  const requested = textParam(query, 'file');
  // Refusal first, index lookup second — see `resolveRequestedFile`.
  const { record, storedPath, absolute } = resolveRequestedFile(cg, projectRoot, requested);

  const from = intParam(query, 'from', { min: 1, max: 5_000_000, default: 1 });
  const to = intParam(query, 'to', { min: 1, max: 5_000_000, default: 0 });
  if (to !== 0 && to < from) {
    throw badRequest(`Parameter "to" (${to}) must not be before "from" (${from}).`);
  }

  const base: SourceResult = {
    file: storedPath.replace(/\\/g, '/'),
    language: record.language,
    drift: false,
    contentHash: record.contentHash,
    indexedAt: record.indexedAt,
    generated: record.generated === true,
    totalLines: null,
  };

  let stats: fs.Stats;
  try {
    stats = fs.statSync(absolute);
  } catch {
    // Indexed but gone. That IS drift, and the strongest kind: nothing on disk
    // corresponds to the ranges the graph holds.
    return { ...base, drift: true, reason: 'The file is in the index but no longer on disk.' };
  }
  if (stats.size > MAX_SOURCE_BYTES) {
    throw badRequest(
      `${base.file} is ${Math.round(stats.size / 1024 / 1024)} MB — too large to serve as source.`
    );
  }

  let content: string;
  try {
    content = fs.readFileSync(absolute, 'utf-8');
  } catch (err) {
    throw new ApiError(
      'internal',
      `Could not read ${base.file}: ${err instanceof Error ? err.message : String(err)}`
    );
  }

  // Byte-identical to extraction's `hashContent` (sha256 over the utf-8
  // string). A touch or a checkout that rewrote the same bytes must not count
  // as drift, which is exactly what hashing content rather than mtime buys.
  const hash = createHash('sha256').update(content).digest('hex');
  if (hash !== record.contentHash) {
    return {
      ...base,
      drift: true,
      reason:
        'This file changed on disk after the last index sync, so the indexed line ' +
        'ranges no longer reliably match. Source is omitted rather than risk showing ' +
        "a different symbol's code; it returns after the next sync.",
    };
  }

  const all = splitLines(content);
  // Past the end of the file `from` names nothing, which is a caller bug worth
  // surfacing rather than answering with the last line as if that were meant.
  // `to` past the end is different — "line 30 to the end, whatever that is" is
  // an ordinary way to ask, so it clamps.
  if (from > all.length) {
    throw badRequest(
      `Parameter "from" (${from}) is past the end of ${base.file}, which has ${all.length} lines.`
    );
  }
  const start = from;
  const requestedEnd = to === 0 ? all.length : Math.min(to, all.length);
  const end = Math.min(requestedEnd, start + MAX_SOURCE_LINES - 1);
  const slice = all.slice(start - 1, end);

  return {
    ...base,
    totalLines: all.length,
    from: start,
    to: end,
    lines: slice,
    truncated: end < requestedEnd,
    // Keyed on the content hash, so the cache is invalidated by the file
    // changing rather than by a clock, and two viewers looking at the same
    // symbol share one tokenisation.
    highlight: await highlightLines(slice, {
      language: record.language,
      cacheKey: `${record.contentHash}:${start}:${end}`,
    }),
  };
}
