#!/usr/bin/env node
/**
 * Extract a release-notes block from CHANGELOG.md for a given version
 * (or unwrap text supplied on stdin), then join hard-wrapped paragraphs.
 *
 * Why: GitHub renders release-note Markdown with GFM hard breaks, so
 * every `\n` becomes `<br>`. The CHANGELOG is hard-wrapped at ~75
 * chars for readable diffs, which then renders as awkward visible
 * line breaks on the release page. This script joins indented
 * continuation lines into a single line per bullet so the GFM
 * renderer produces clean paragraphs.
 *
 * Repo-level CHANGELOG.md viewing is unaffected (CommonMark treats
 * newlines as spaces there).
 *
 * Usage:
 *   extract-release-notes.mjs <version>     # read CHANGELOG.md
 *   extract-release-notes.mjs --stdin       # read from stdin (any text)
 *   extract-release-notes.mjs --max-chars N # cap output at N characters
 *
 * The GitHub Releases API rejects a release body longer than 125,000
 * characters ("body is too long"). The fork release path therefore caps
 * the notes with --max-chars for the release artifact only; CHANGELOG.md
 * itself always keeps the full text. Trimming is bullet-granular (never
 * mid-bullet) and the truncated block gets a pointer to the changelog.
 */

import { readFileSync } from 'fs';

const argv = process.argv.slice(2);
let arg;
let maxChars = 0;
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--stdin') {
    arg = '--stdin';
  } else if (a === '--max-chars') {
    const n = argv[++i];
    maxChars = Number.parseInt(n, 10);
    if (!Number.isInteger(maxChars) || maxChars <= 0) {
      console.error(`--max-chars expects a positive integer, got: ${n}`);
      process.exit(1);
    }
  } else if (!arg) {
    arg = a;
  }
}
if (!arg) {
  console.error('usage: extract-release-notes.mjs <version> | --stdin [--max-chars N]');
  process.exit(1);
}

let block;
if (arg === '--stdin') {
  block = readFileSync(0, 'utf8').replace(/\r\n?/g, '\n').split('\n');
} else {
  const version = arg;
  const escaped = version.replace(/\./g, '\\.');
  const headerRe = new RegExp(`^## \\[${escaped}\\]`);
  const anyHeaderRe = /^## \[/;
  const lines = readFileSync('CHANGELOG.md', 'utf8').split('\n');
  const start = lines.findIndex((l) => headerRe.test(l));
  if (start === -1) {
    console.error(`no '## [${version}]' entry found in CHANGELOG.md`);
    process.exit(1);
  }
  const after = lines.findIndex((l, i) => i > start && anyHeaderRe.test(l));
  block = lines.slice(start, after === -1 ? lines.length : after);
}

// Track a stack of `{ indent: number }` frames so a continuation line
// can attach to the right ancestor. Handles the post-nested-list
// continuation pattern:
//
//     - top-level
//         - nested
//       back to top-level  <- 2-space indent, joins the top-level bullet
const out = [];
let buf = '';
let stack = [];

function flushBuf() {
  if (buf !== '') {
    out.push(buf);
    buf = '';
  }
}

function leadingSpaces(s) {
  const m = s.match(/^(\s*)/);
  return m ? m[1].length : 0;
}

// Bullets: `-`, `*`, `digit.` only. `+` is intentionally excluded — the
// CHANGELOG uses literal `+` inline (`config + instructions`) and we
// don't want to misread those as nested bullets.
const listItemRe = /^(\s*)([-*]|\d+\.)\s+/;
const fenceRe = /^\s*```/;

let inFence = false;

for (const line of block) {
  // Fenced code blocks: pass through verbatim, no joining.
  if (fenceRe.test(line)) {
    flushBuf();
    stack = [];
    out.push(line);
    inFence = !inFence;
    continue;
  }
  if (inFence) {
    out.push(line);
    continue;
  }
  if (/^\s*$/.test(line)) {
    flushBuf();
    out.push('');
    continue;
  }
  if (/^#/.test(line)) {
    flushBuf();
    stack = [];
    out.push(line);
    continue;
  }
  const itemMatch = line.match(listItemRe);
  if (itemMatch) {
    flushBuf();
    const indent = itemMatch[1].length;
    while (stack.length > 0 && stack[stack.length - 1].indent >= indent) {
      stack.pop();
    }
    stack.push({ indent });
    buf = line;
    continue;
  }
  if (/^\s/.test(line)) {
    const indent = leadingSpaces(line);
    while (stack.length > 1 && stack[stack.length - 1].indent >= indent) {
      flushBuf();
      stack.pop();
    }
    const trimmed = line.replace(/^\s+/, '');
    buf = buf === '' ? trimmed : `${buf} ${trimmed}`;
    continue;
  }
  flushBuf();
  stack = [];
  out.push(line);
}
flushBuf();

// Cap the emitted text for consumers with a hard length limit (GitHub
// Releases: 125,000 characters). Cut only at a bullet boundary — a
// `- ` / `* ` / `N. ` list item line, start-of-heading, or paragraph
// break that is not itself the first body line — so no bullet is split
// in half. Headings stay; prose paragraphs before the first bullet are
// kept whole as long as they fit. Appends a pointer to the full text.
let body = out.join('\n');
if (!out[out.length - 1]?.endsWith('\n')) body += '\n';
if (maxChars > 0 && body.length > maxChars) {
  const cutRe = /^(?:\s*(?:[-*]|\d+\.)\s+|#{1,6}\s|\s*$)/;
  const lines = body.split('\n');
  const kept = [];
  let len = 0;
  let dropped = 0;
  for (const line of lines) {
    if (len + line.length + 1 > maxChars) {
      if (cutRe.test(line) || kept.length === 0) {
        dropped++;
        continue;
      }
      break; // mid-bullet line: stop entirely rather than truncate it
    }
    kept.push(line);
    len += line.length + 1;
  }
  // Never leave a dangling heading with no section content under it.
  while (kept.length > 0 && /^#{1,6}\s/.test(kept[kept.length - 1])) {
    kept.pop();
  }
  const pointer = [
    '',
    `_(Release notes trimmed to fit GitHub's release-body limit; the rest of this`,
    `release — ${dropped} more entries — is in [CHANGELOG.md](https://github.com/${process.env.GITHUB_REPOSITORY ?? 'colbymchenry/codegraph'}/blob/main/CHANGELOG.md).)_`,
    '',
  ].join('\n');
  body = [...kept, pointer].join('\n');
}

process.stdout.write(body);
if (!body.endsWith('\n')) process.stdout.write('\n');
