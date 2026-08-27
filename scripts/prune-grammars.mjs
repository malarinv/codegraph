#!/usr/bin/env node
/**
 * Write the TextMate grammars the viewer needs into `dist/textmate/`.
 *
 * Shiki carries about 700 grammars, 11 MB of JSON. The engine indexes about 40
 * languages. Shipping the other 660 to every user of a code-intelligence CLI is
 * not a trade worth making, so `@shikijs/langs` stays a devDependency and this
 * step copies out exactly the closure the viewer can reach: every grammar named
 * in `src/ui-server/highlight/languages.ts`, plus every grammar those embed
 * (`vue` needs html, css, typescript, json and four Vue-specific ones before it
 * will highlight a single-file component).
 *
 * Run from `npm run build`, after `tsc`, because the language table is read
 * from the compiled `dist/ui-server/highlight/languages.js` rather than being
 * duplicated here — one source of truth for what ships.
 *
 * Output:
 *   dist/textmate/manifest.json      grammar id -> files to load, deps first
 *   dist/textmate/<name>.json        one TextMate grammar, verbatim
 */

import { createRequire } from 'node:module';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'dist', 'textmate');
const require = createRequire(import.meta.url);

function fail(message) {
  process.stderr.write(`[prune-grammars] ${message}\n`);
  process.exit(1);
}

const languagesModule = path.join(ROOT, 'dist', 'ui-server', 'highlight', 'languages.js');
if (!fs.existsSync(languagesModule)) {
  fail(`${path.relative(ROOT, languagesModule)} is missing — run tsc before this script.`);
}
const { REQUIRED_GRAMMARS } = require(languagesModule);
if (!Array.isArray(REQUIRED_GRAMMARS) || REQUIRED_GRAMMARS.length === 0) {
  fail('REQUIRED_GRAMMARS is empty — the language table did not compile as expected.');
}

const shikiVersion = JSON.parse(
  fs.readFileSync(path.join(ROOT, 'node_modules', '@shikijs', 'langs', 'package.json'), 'utf-8')
).version;

/**
 * Load one Shiki language module and return its registrations.
 *
 * The default export is already the flattened chain — embedded grammars first,
 * the language itself last — which is exactly the order Shiki's registry needs
 * to resolve `embeddedLangs`. Keeping that order is the whole reason the
 * manifest stores a list rather than a single filename.
 */
async function loadChain(id) {
  const mod = await import(`@shikijs/langs/${id}`);
  const chain = mod.default;
  if (!Array.isArray(chain) || chain.length === 0) {
    fail(`@shikijs/langs/${id} did not export a grammar array.`);
  }
  return chain;
}

fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });

const manifest = { shikiVersion, languages: {} };
const written = new Map();
let bytes = 0;

for (const id of REQUIRED_GRAMMARS) {
  let chain;
  try {
    chain = await loadChain(id);
  } catch (err) {
    fail(`could not load the ${id} grammar: ${err?.message ?? err}`);
  }

  const files = [];
  for (const grammar of chain) {
    // A chain can name the same dependency more than once (Vue reaches
    // JavaScript four different ways). Registering it twice is wasted work and
    // a confusing manifest; the FIRST occurrence is the one that keeps the
    // dependencies-before-dependents ordering intact.
    // `name` is the grammar's own id and is unique across the bundle, so two
    // languages that embed html write (and share) exactly one html.json.
    const file = grammar.name;
    if (typeof file !== 'string' || !/^[\w.+-]+$/.test(file)) {
      fail(`the ${id} chain contains a grammar with an unusable name: ${JSON.stringify(file)}`);
    }
    if (files.includes(file)) continue;
    if (!written.has(file)) {
      const json = JSON.stringify(grammar);
      fs.writeFileSync(path.join(OUT, `${file}.json`), json);
      written.set(file, json.length);
      bytes += json.length;
    }
    files.push(file);
  }
  manifest.languages[id] = files;
}

fs.writeFileSync(path.join(OUT, 'manifest.json'), JSON.stringify(manifest, null, 2));

process.stdout.write(
  `[prune-grammars] ${REQUIRED_GRAMMARS.length} languages -> ${written.size} grammars, ` +
    `${(bytes / 1024 / 1024).toFixed(1)} MB in dist/textmate (shiki ${shikiVersion})\n`
);
