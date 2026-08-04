/**
 * Score-proportional explore allocation, end to end (CG-14 / epic CG-1 / #1500).
 *
 * `explore-proportional-allocation.test.ts` pins `allocateExploreBudget` in
 * isolation; `explore-allocation-1500.test.ts` pins the reporter's Go shape.
 * What is left — and what this file owns — is everything the allocator only
 * *promises*: the render loop has to spend those reservations, the hard ceiling
 * has to catch the overshoot, and a degenerate or diffuse result set has to come
 * back usable rather than empty. Each of those is invisible to a unit test,
 * because the failure mode is not an exception — it is a response the agent
 * quietly abandons in favour of Read.
 *
 * Two halves:
 *
 *  1. **The self-query fixture's shape.** CG-6 declared a second regression
 *     fixture beside payroll-go: this repo, asked "how does explore allocate its
 *     output budget across files", spending 63% of its envelope on
 *     `scripts/agent-eval/*.mjs` files that merely mention `explore` and
 *     `BUDGET`, while `src/mcp/tools.ts` — the file that actually answers — sat
 *     clipped at the flat `maxCharsPerFile`. That fixture reads THIS repo's live
 *     index, so it belongs to the out-of-band probe
 *     (`node scripts/agent-eval/probe-allocation.mjs self-query`) where its
 *     numbers can move with the repo. Reproduced here as a synthetic project so
 *     `npm test` owns the MECHANISM deterministically: a large relevant file, a
 *     small genuinely-relevant helper, and an incidental name-collision script.
 *
 *  2. **Degenerate and diffuse result sets.** One file, no files, all files
 *     scoring alike, a survey question. The proportional split divides by a total
 *     weight and concentrates on a leader — both of which have a degenerate case
 *     that ends in a division by zero or a starved response.
 *
 * Nothing here is platform-gated: fixtures are written through `path.join`, and
 * every path ASSERTED against is an indexed relative path, which extraction
 * normalizes to forward slashes on every platform (`normalizePath`, utils.ts).
 * A literal like `src/mcp/allocator.ts` is therefore correct on Windows too —
 * gate a new assertion with `it.runIf` only if it reaches for a real filesystem
 * path or a platform-specific separator.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import CodeGraph from '../src/index';
import { ToolHandler, getExploreOutputBudget, EXPLORE_ALLOCATION } from '../src/mcp/tools';
import { attributeSourceBytes } from '../src/mcp/explore-diagnostics';
import type { ExploreDiagnosticReport } from '../src/mcp/explore-diagnostics';

/** The host's inline tool-result limit — above it the response is externalized. */
const INLINE_CAP = 25000;

const DEBUG_ENV = 'CODEGRAPH_EXPLORE_DEBUG';

interface Project {
  dir: string;
  cg: CodeGraph;
  handler: ToolHandler;
}

/** Build + index a throwaway project from a `{ relPath: source }` map. */
async function buildProject(prefix: string, files: Record<string, string>): Promise<Project> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  for (const [rel, body] of Object.entries(files)) {
    const abs = path.join(dir, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, body.trimStart());
  }
  const cg = CodeGraph.initSync(dir);
  await cg.indexAll();
  return { dir, cg, handler: new ToolHandler(cg) };
}

function destroyProject(project?: Project): void {
  if (!project) return;
  project.cg.destroy();
  if (fs.existsSync(project.dir)) fs.rmSync(project.dir, { recursive: true, force: true });
}

/**
 * One explore call, reduced to what the allocation assertions need — plus the
 * CG-4 per-file diagnostic, which is where the SCORE and the RESERVATION live.
 * The instrument is observational (byte-identical output either way), so reading
 * it here measures the same response the agent would have received.
 */
async function explore(project: Project, query: string) {
  // Outside the project root on purpose: a sidecar written INTO the indexed tree
  // is a new file the watcher can pick up mid-suite.
  const sidecar = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-alloc-diag-')), 'report.jsonl');
  const previous = process.env[DEBUG_ENV];
  process.env[DEBUG_ENV] = sidecar;
  let result;
  try {
    result = await project.handler.execute('codegraph_explore', { query });
  } finally {
    if (previous === undefined) delete process.env[DEBUG_ENV];
    else process.env[DEBUG_ENV] = previous;
  }
  const text = result.content?.[0]?.text ?? '';
  const bytes = attributeSourceBytes(text);
  const lines = fs.existsSync(sidecar)
    ? fs.readFileSync(sidecar, 'utf-8').trim().split('\n').filter(Boolean)
    : [];
  const report = JSON.parse(lines[lines.length - 1]!) as ExploreDiagnosticReport;
  fs.rmSync(path.dirname(sidecar), { recursive: true, force: true });
  const fileOf = (file: string) => report.files.find((f) => f.path === file);
  return {
    text,
    bytes,
    report,
    isError: result.isError === true,
    /** Relevance score the ranking pass gave this file. */
    score: (file: string) => fileOf(file)?.score ?? 0,
    /** Chars of source the allocator RESERVED for it, before anything rendered. */
    allowance: (file: string) => fileOf(file)?.allowance ?? 0,
    /** Fraction of the WHOLE response this file's source occupies. */
    share: (file: string) => (bytes.get(file) ?? 0) / (text.length || 1),
    shareUnder: (prefix: string) => {
      let total = 0;
      for (const [file, n] of bytes) if (file.startsWith(prefix)) total += n;
      return total / (text.length || 1);
    },
  };
}

// ── 1. The self-query fixture's shape ───────────────────────────────────────

describe('#1500 fixture 2 — allocation followed FILE SIZE, not relevance', () => {
  /**
   * The three roles from the real fixture, at synthetic scale:
   *
   *  - `src/mcp/allocator.ts` — stands in for `src/mcp/tools.ts`. Carries the
   *    query's terms on real functions with real call edges, and is deliberately
   *    too big to ship whole, so under the old rule it was clipped at the flat
   *    `maxCharsPerFile` no matter how far it outscored its peers.
   *  - `src/util/budget-math.ts` — stands in for `src/resolution/memory-budget.ts`.
   *    Genuinely relevant (the allocator calls it) but scoring about half as
   *    well — and small enough to ship WHOLE, which under the old rule was worth
   *    more than being right.
   *  - `scripts/eval-harness.mjs` — stands in for `scripts/agent-eval/*.mjs`. Its
   *    only claim on the query is a file-scope `explore` and `BUDGET` that nothing
   *    reads: the incidental collision CG-10 demoted.
   *
   * Measured on this fixture, reverting the render loop to the pre-CG-12 rules
   * (`fileBudget = maxCharsPerFile`, whole-file bound `maxCharsPerFile * 3`)
   * reproduces the report exactly — and every gate below goes red:
   *
   * | file                    | score | pre-CG-12      | CG-12          |
   * |-------------------------|-------|----------------|----------------|
   * | `src/mcp/allocator.ts`  |  77.5 |  4,843 (39.7%) |  9,335 (80.1%) |
   * | `src/util/budget-math.ts` | 36.0 |  6,079 (49.8%) |  1,037 ( 8.9%) |
   *
   * The half-as-relevant file taking the larger share, purely on size, IS #1500.
   */
  const QUERY = 'how does explore allocate its output budget across files';
  const ALLOCATOR = 'src/mcp/allocator.ts';
  const HELPER = 'src/util/budget-math.ts';
  const INCIDENTAL = 'scripts/eval-harness.mjs';

  const allocatorPass = (index: number, name: string) => `
/** ${name}: one pass of the explore output split. */
export function ${name}(
  candidates: AllocationCandidate[],
  budget: ExploreOutputBudget,
): Map<string, number> {
  const allowances = new Map<string, number>();
  const pool = clampOutputBudget(budget.maxOutputChars - ${index} * 200);
  const total = candidates.reduce((sum, candidate) => sum + candidate.score, 0);
  if (total <= 0) {
    return allowances;
  }
  const floors = Math.min(pool, 700 * candidates.length);
  const remainder = budgetRemainderAfterFloors(pool, floors);
  for (const candidate of candidates) {
    const floor = Math.floor(floors / candidates.length);
    const proportional = splitOutputEvenly(remainder, total, candidate.score);
    const boosted = candidate.spine ? proportional * 2 : proportional;
    const share = Math.min(floor + boosted, budget.maxCharsPerFile * 3);
    if (share <= 0) {
      continue;
    }
    allowances.set(candidate.path, share);
  }
  return allowances;
}
`;

  /**
   * Neutral bulk for the helper file: real symbols that match NOTHING in the
   * query, so the file grows in BYTES without gaining relevance. That asymmetry
   * is the fixture — the real `memory-budget.ts` won 51% of the envelope against
   * a file scoring twice its score purely by being small enough to ship whole.
   */
  const helperFiller = (n: number) => `
export function normalizeLedgerRow${n}(row: string[], fallback: string): string[] {
  const trimmed = row.map((cell) => cell.trim()).filter((cell) => cell.length > 0);
  return trimmed.length > 0 ? trimmed : [fallback];
}
`;

  const ALLOCATOR_SOURCE = `
/** Explore budget allocation: splits the output envelope across relevant files. */
export interface ExploreOutputBudget {
  maxOutputChars: number;
  maxCharsPerFile: number;
  defaultMaxFiles: number;
}

export interface AllocationCandidate {
  path: string;
  score: number;
  spine: boolean;
}
${[
  'allocateExploreBudget',
  'reserveOutputPerFile',
  'distributeOutputBudget',
  'planExploreOutput',
  'spendExploreBudget',
  'balanceOutputAcrossFiles',
  'concentrateExploreOutput',
  'settleExploreAllocation',
  'apportionExploreBudget',
  'rationOutputAcrossFiles',
  'tallyExploreOutputBudget',
  'weighExploreAllocation',
].map((name, i) => allocatorPass(i + 1, name)).join('')}
import {
  clampOutputBudget,
  splitOutputEvenly,
  budgetRemainderAfterFloors,
} from '../util/budget-math';
`;

  let project: Project;
  let run: Awaited<ReturnType<typeof explore>>;

  beforeAll(async () => {
    project = await buildProject('codegraph-alloc-selfquery-', {
      [ALLOCATOR]: ALLOCATOR_SOURCE,
      [HELPER]: `
/** Budget arithmetic the explore output allocator leans on. */
export function clampOutputBudget(value: number): number {
  if (value < 0) return 0;
  return Math.floor(value);
}

export function splitOutputEvenly(pool: number, total: number, score: number): number {
  if (total <= 0) return 0;
  return Math.floor((pool * score) / total);
}

export function budgetRemainderAfterFloors(pool: number, floors: number): number {
  const remainder = pool - floors;
  return remainder > 0 ? remainder : 0;
}

export function splitBudgetAcrossFiles(pool: number, fileCount: number): number {
  return fileCount > 0 ? Math.floor(pool / fileCount) : pool;
}

export function describeOutputBudget(pool: number, perFile: number): string {
  return \`explore budget pool of \${pool} chars, \${perFile} per file\`;
}
${Array.from({ length: 22 }, (_, i) => helperFiller(i + 1)).join('')}`,
      [INCIDENTAL]: `
// Eval harness. Mentions explore and BUDGET incidentally; nothing here allocates.
const explore = 'explore';
const BUDGET = 24000;

export function runHarness(repo) {
  const rows = [];
  for (const line of repo.split('\\n')) {
    rows.push(line.trim());
  }
  return rows;
}

export function summarizeRun(rows) {
  return { count: rows.length, first: rows[0] };
}
`,
      'src/mcp/server.ts': `
import { allocateExploreBudget } from './allocator';

export function serve(candidates: any[]) {
  return allocateExploreBudget(candidates, { maxOutputChars: 13000, maxCharsPerFile: 3800, defaultMaxFiles: 4 });
}
`,
      'src/util/logger.ts': `
export function log(message: string): void {
  console.log(message);
}
`,
    });
    run = await explore(project, QUERY);
  }, 120_000);

  afterAll(() => destroyProject(project));

  describe('fixture shape', () => {
    it('indexes all three roles, so a zero share means demoted and not missing', () => {
      // Without this the incidental assertion below could pass vacuously — a file
      // that was never indexed also delivers 0 bytes.
      for (const rel of [ALLOCATOR, HELPER, INCIDENTAL]) {
        expect(project.cg.getFile(rel), `${rel} indexed`).toBeTruthy();
      }
    });

    it('sizes the two files so the size-driven render split actually bites', () => {
      // The mechanism the epic is about. The answer file must be too big to ship
      // whole (so the old flat cap clipped it), and the helper small enough that
      // shipping it whole was always affordable under the old `maxCharsPerFile * 3`
      // bound. Without that asymmetry the fixture stops reproducing anything.
      const budget = getExploreOutputBudget(project.cg.getFiles().length);
      const answer = fs.readFileSync(path.join(project.dir, ALLOCATOR), 'utf-8');
      const helper = fs.readFileSync(path.join(project.dir, HELPER), 'utf-8');
      expect(answer.split('\n').length).toBeGreaterThan(280);
      expect(answer.length).toBeGreaterThan(budget.maxCharsPerFile * 3);
      expect(helper.split('\n').length).toBeLessThan(220);
      expect(helper.length).toBeLessThan(budget.maxCharsPerFile * 3);
    });

    it('scores the answer file well above the helper it calls', () => {
      // The other half of the asymmetry: the reversal below only means something
      // if the file that used to WIN the envelope was the less relevant one.
      expect(run.score(ALLOCATOR)).toBeGreaterThan(run.score(HELPER) * 1.5);
    });
  });

  describe('budget allocation', () => {
    it('gives the file that answers the question the majority of the envelope', () => {
      // The epic's acceptance bar for this fixture: >50%, from 18.5% at baseline.
      // Pre-CG-12 this file took 39.7% — behind the helper it calls.
      expect(run.share(ALLOCATOR)).toBeGreaterThan(0.5);
    });

    it('lets the answer file spend multiples of the flat cap it used to be clipped at', () => {
      // The mechanism as a byte count rather than a share: this file is too big
      // to ship whole, so under the old rule its source was truncated at
      // `maxCharsPerFile` however far it outscored its peers. Its reservation is
      // now several times that cap. A build that re-imposes a flat per-file cap
      // fails HERE first — it delivered 4,843 against a 3,800 cap.
      const budget = getExploreOutputBudget(project.cg.getFiles().length);
      expect(run.bytes.get(ALLOCATOR) ?? 0).toBeGreaterThan(budget.maxCharsPerFile * 2);
    });

    it('stops the smaller file winning on size — it no longer ships whole', () => {
      // The reversal, from the other side. The helper scores about half the
      // answer file and is small enough that the old whole-file bound shipped it
      // ENTIRE (6,079 chars, 49.8% of the envelope — more than the file that
      // answered the question). It now clusters inside its proportional share.
      const helperSource = fs.readFileSync(path.join(project.dir, HELPER), 'utf-8');
      const delivered = run.bytes.get(HELPER) ?? 0;
      expect(delivered).toBeGreaterThan(0);
      expect(delivered).toBeLessThan(helperSource.length);
    });

    it('orders per-file shares by relevance, not by file size', () => {
      // Both files deliver — this is not concentration by elimination — but the
      // one that answers the question gets several times the bytes of the helper
      // it calls. Pre-CG-12 this ratio was 0.8, i.e. inverted.
      const answer = run.share(ALLOCATOR);
      const helper = run.share(HELPER);
      expect(helper).toBeGreaterThan(0);
      expect(answer).toBeGreaterThan(helper * 3);
    });

    it('spends nothing on the incidental name collision', () => {
      expect(run.bytes.get(INCIDENTAL) ?? 0).toBe(0);
      expect(run.shareUnder('scripts/')).toBe(0);
    });

    it('reserves in proportion to score, before anything renders', () => {
      // The reservations are the contract the render loop then spends. Asserting
      // them directly — not just the bytes that came out — separates "allocation
      // is proportional" from "the render loop happened to emit these sizes".
      const answerReserved = run.allowance(ALLOCATOR);
      const helperReserved = run.allowance(HELPER);
      expect(answerReserved).toBeGreaterThan(helperReserved);
      expect(answerReserved / helperReserved).toBeGreaterThan(run.score(ALLOCATOR) / run.score(HELPER) * 0.5);
      // Nothing is over-promised: the sum of reservations fits the pool, and the
      // pool fits the envelope. This is the invariant the whole epic rests on.
      expect(run.report.allocation.reserved).toBeLessThanOrEqual(run.report.allocation.pool);
      expect(run.report.allocation.pool).toBeLessThanOrEqual(run.report.budget.maxOutputChars);
    });

    it('keeps the response inside the hard ceiling and under the inline cap', () => {
      // Two different bounds, and it matters which is which. `maxOutputChars`
      // bounds the RESERVATIONS (asserted above); the RESPONSE is bounded by
      // `hardCeiling` — 1.5x the envelope, capped at 25K — because the render
      // loop is allowed a bounded overshoot for the whole-file grace and an
      // oversize first cluster. The 25K is the one that must never move: past it
      // the host writes the result to a file the agent Reads back.
      const budget = getExploreOutputBudget(project.cg.getFiles().length);
      const hardCeiling = Math.min(Math.round(budget.maxOutputChars * 1.5), INLINE_CAP);
      expect(run.text.length).toBeLessThanOrEqual(hardCeiling);
      expect(run.text.length).toBeLessThan(INLINE_CAP);
    });

    it('records the shape of the split so a regression is legible', () => {
      // Not a gate — a snapshot, so a change that shifts the split shows up in the
      // diff rather than silently flipping a threshold.
      expect({
        answerWinsEnvelope: run.share(ALLOCATOR) > run.share(HELPER),
        helperStillDelivers: (run.bytes.get(HELPER) ?? 0) > 0,
        incidentalDelivers: (run.bytes.get(INCIDENTAL) ?? 0) > 0,
      }).toEqual({
        answerWinsEnvelope: true,
        helperStillDelivers: true,
        incidentalDelivers: false,
      });
    });
  });
});

// ── 2. Degenerate and diffuse result sets ───────────────────────────────────

describe('allocation on degenerate result sets', () => {
  let project: Project;

  beforeAll(async () => {
    // Four modules that are deliberate COPIES of each other, plus one unrelated
    // file. Copies are the pathological input for a proportional split: every
    // candidate carries the same weight, so the split divides by a denominator
    // that is entirely made of ties.
    const twin = (n: number) => `
export class InventoryLedger${n} {
  private rows: number[] = [];

  public recordInventoryMovement(quantity: number): void {
    this.rows.push(quantity);
  }

  public settleInventoryLedger(): number {
    return this.rows.reduce((sum, row) => sum + row, 0);
  }
}
`;
    project = await buildProject('codegraph-alloc-degenerate-', {
      'src/ledger/one.ts': twin(1),
      'src/ledger/two.ts': twin(2),
      'src/ledger/three.ts': twin(3),
      'src/ledger/four.ts': twin(4),
      'src/unrelated/colors.ts': `
export const PALETTE = ['oxblood', 'paper', 'ink'];

export function pickPaletteEntry(index: number): string {
  return PALETTE[index % PALETTE.length]!;
}
`,
    });
  }, 120_000);

  afterAll(() => destroyProject(project));

  it('does not starve anyone when every file scores identically', async () => {
    // The all-ties case, end to end: no division by zero, nobody cliffed for
    // being relatively weak (nothing IS relatively weak), and no single copy
    // sweeping the envelope on an arbitrary tiebreak.
    const run = await explore(project, 'how does the inventory ledger record and settle movements');
    expect(run.isError).toBe(false);
    const ledger = [...run.bytes].filter(([file]) => file.startsWith('src/ledger/'));
    expect(ledger.length).toBeGreaterThanOrEqual(2);
    const shares = ledger.map(([, n]) => n);
    expect(Math.max(...shares) / Math.min(...shares)).toBeLessThan(3);
    for (const [file, n] of ledger) {
      expect(n, `${file} starved`).toBeGreaterThan(0);
    }
    // The reservations behind those bytes divided cleanly too.
    expect(run.report.allocation.reserved).toBeLessThanOrEqual(run.report.allocation.pool);
  });

  it('answers a single-file question without over-spending the envelope on it', async () => {
    const run = await explore(project, 'pickPaletteEntry');
    expect(run.isError).toBe(false);
    expect(run.bytes.get('src/unrelated/colors.ts') ?? 0).toBeGreaterThan(0);
    const budget = getExploreOutputBudget(project.cg.getFiles().length);
    // One dominant file still cannot exceed the share ceiling, and the response
    // as a whole still fits the envelope's hard ceiling.
    expect(run.bytes.get('src/unrelated/colors.ts')!)
      .toBeLessThanOrEqual(Math.round(budget.maxOutputChars * EXPLORE_ALLOCATION.MAX_SHARE));
    expect(run.text.length).toBeLessThan(INLINE_CAP);
  });

  it('returns guidance rather than an error when nothing matches', async () => {
    // An `isError` response teaches the agent to abandon codegraph for the rest
    // of the session, so a zero-result allocation must stay success-shaped.
    const run = await explore(project, 'quantumFluxCapacitorHandshake');
    expect(run.isError).toBe(false);
    expect(run.text.length).toBeGreaterThan(0);
    expect(run.bytes.size).toBe(0);
  });
});

describe('the diffuse-query control', () => {
  let project: Project;

  beforeAll(async () => {
    // Six genuinely distinct subsystems, each a legitimate partial answer to a
    // survey question. Concentration is the epic's goal, but over-correcting here
    // costs a round-trip: the agent's fallback for an under-served survey is
    // Grep, not a second explore.
    const subsystem = (name: string, verb: string) => `
export interface ${name}Options {
  retries: number;
}

export class ${name}Service {
  constructor(private readonly options: ${name}Options) {}

  public ${verb}Request(payload: string): string {
    return this.describe${name}() + ':' + payload;
  }

  public describe${name}(): string {
    return '${name} with ' + this.options.retries + ' retries';
  }
}
`;
    project = await buildProject('codegraph-alloc-diffuse-', {
      'src/services/auth.ts': subsystem('Auth', 'authorize'),
      'src/services/billing.ts': subsystem('Billing', 'charge'),
      'src/services/search.ts': subsystem('Search', 'query'),
      'src/services/notify.ts': subsystem('Notify', 'publish'),
      'src/services/report.ts': subsystem('Report', 'render'),
      'src/services/audit.ts': subsystem('Audit', 'record'),
    });
  }, 120_000);

  afterAll(() => destroyProject(project));

  it('still returns a spread for a survey-style question', async () => {
    // The over-correction guard for CG-10's floor and CG-12's cliff together: a
    // question with no single right answer must come back as several usable
    // sections, not one file plus a pointer list.
    const run = await explore(project, 'what services does this project expose and what does each one do');
    expect(run.isError).toBe(false);
    const services = [...run.bytes].filter(([file]) => file.startsWith('src/services/'));
    expect(services.length).toBeGreaterThanOrEqual(3);
    const total = services.reduce((sum, [, n]) => sum + n, 0);
    expect(total).toBeGreaterThan(0);
    for (const [file, n] of services) {
      // Nobody is reduced to a fragment, and nobody swallows the response.
      expect(n, `${file} fragment`).toBeGreaterThan(200);
      expect(n / total, `${file} hogged the envelope`).toBeLessThan(0.8);
    }
  });

  it('names whatever it could not show, so the spread stays completable', async () => {
    const run = await explore(project, 'what services does this project expose and what does each one do');
    const shown = [...run.bytes.keys()].filter((f) => f.startsWith('src/services/'));
    const missing = ['auth', 'billing', 'search', 'notify', 'report', 'audit']
      .map((n) => `src/services/${n}.ts`)
      .filter((f) => !shown.includes(f));
    for (const file of missing) {
      expect(run.text, `${file} dropped without a pointer`).toContain(file);
    }
  });
});
