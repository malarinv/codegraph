/**
 * Regression fixture for GitHub issue #1500 / epic CG-1 — relevance-proportional
 * explore budget allocation.
 *
 * The reporter's repo is a Go service whose GENERATED FKIT CRUD layer sits beside
 * the hand-written use-case that does the real work. Asking an architecture
 * question that doesn't name the exact use-case ("how does payroll cycle create
 * and calculate payslips?") spends the explore envelope on the generated CRUD,
 * because the generated layer name-collides on every term in the question while
 * the hand-written workflow is one big file that gets clipped.
 *
 * `__tests__/fixtures/payroll-go/` reproduces that shape permanently. This suite
 * is in two halves:
 *
 *  1. **Fixture shape** — green today. These pin the properties the fixture must
 *     keep for the gate below to mean anything: the generated/hand-written split
 *     (including the ordinary-named generated files only a CONTENT header betrays,
 *     which is the #1500 case), the deliberate name collisions, and the
 *     runPayrollCycleAll → BuildPayslip → Upsert chain resolving end-to-end. If
 *     the fixture rots, these fail first and say so.
 *
 *  2. **Budget allocation** — the gate, written with `it.fails` because it
 *     DOCUMENTS A BUG THAT IS STILL OPEN. Vitest passes an `it.fails` test only
 *     while its body throws, so the suite is green today and goes RED the moment
 *     allocation is fixed (CG-10 scoring + CG-12 proportional bytes).
 *     **When it goes red, delete the `.fails` — do not delete the test.**
 *
 * The same assertions run outside vitest, against the built dist and with the
 * full CG-4 per-file diagnostic, via `node scripts/agent-eval/probe-allocation.mjs`
 * (declared in `scripts/agent-eval/allocation-fixtures.json`).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import CodeGraph from '../src/index';
import { ToolHandler } from '../src/mcp/tools';
import { attributeSourceBytes } from '../src/mcp/explore-diagnostics';
import { isGeneratedFile, hasGeneratedHeader } from '../src/extraction/generated-detection';

const FIXTURE_SRC = path.join(__dirname, 'fixtures', 'payroll-go');

/** The question a newcomer asks — names none of the symbols that answer it. */
const QUERY = 'how does payroll cycle create and calculate payslips?';

/** The hand-written workflow: what the query is actually about. */
const ANSWER_PREFIXES = [
  'internal/usecase/',
  'internal/store/',
  'internal/transport/',
  'internal/domain/',
  'cmd/',
];
/** The generated CRUD/DTO layer: what wins the envelope today. */
const GENERATED_PREFIX = 'internal/gen/';

const startsWithAny = (p: string, prefixes: string[]) => prefixes.some((x) => p.startsWith(x));

describe('#1500 — generated Go CRUD beside a hand-written payroll workflow', () => {
  let testDir: string;
  let cg: CodeGraph;
  let handler: ToolHandler;
  let response: string;
  /** Delivered source bytes per file, attributed from the final response. */
  let bytes: Map<string, number>;

  beforeAll(async () => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-1500-'));
    fs.cpSync(FIXTURE_SRC, testDir, { recursive: true });
    // A stray index in the checked-in tree would be copied in and reused.
    fs.rmSync(path.join(testDir, '.codegraph'), { recursive: true, force: true });

    cg = CodeGraph.initSync(testDir);
    await cg.indexAll();
    handler = new ToolHandler(cg);

    const result = await handler.execute('codegraph_explore', { query: QUERY });
    response = result.content?.[0]?.text ?? '';
    bytes = attributeSourceBytes(response);
  }, 120_000);

  afterAll(() => {
    if (cg) cg.destroy();
    if (testDir && fs.existsSync(testDir)) fs.rmSync(testDir, { recursive: true, force: true });
  });

  // ── 1. Fixture shape ──────────────────────────────────────────────────────

  describe('fixture shape', () => {
    it('indexes as a Go project with both layers present', () => {
      const files = cg.getFiles().map((f) => f.path);
      expect(files.filter((p) => p.endsWith('.go')).length).toBeGreaterThanOrEqual(15);
      expect(files.some((p) => p.startsWith(GENERATED_PREFIX))).toBe(true);
      expect(files.some((p) => p.startsWith('internal/usecase/'))).toBe(true);
    });

    it('flags every generated file and no hand-written one', () => {
      for (const file of cg.getFiles()) {
        expect(file.generated, `${file.path} generated flag`).toBe(
          file.path.startsWith(GENERATED_PREFIX),
        );
      }
    });

    it('carries generated files that ONLY a content header betrays — the #1500 case', () => {
      // Half the generated tree has ordinary names (`payslip.go`, `store.go`).
      // Path-only detection misses them; the CG-5 content check is what catches
      // them. Without these the fixture would be a .pb.go fixture, not a #1500 one.
      const contentOnly = [
        'internal/gen/fkit/payroll/payslip.go',
        'internal/gen/fkit/payroll/payroll_cycle.go',
        'internal/gen/fkit/payroll/store.go',
        'internal/gen/fkit/payroll/calculate.go',
        'internal/gen/fkit/payroll/dto.go',
        'internal/gen/fkit/employee/employee.go',
        'internal/gen/fkit/timesheet/timesheet.go',
      ];
      for (const rel of contentOnly) {
        const source = fs.readFileSync(path.join(testDir, rel), 'utf-8');
        expect(isGeneratedFile(rel), `${rel} must NOT be detectable by path`).toBe(false);
        expect(hasGeneratedHeader(source), `${rel} must be detectable by header`).toBe(true);
        expect(cg.getFile(rel)?.generated, `${rel} indexed flag`).toBe(true);
      }
      // …beside the conventional path-detectable ones, so both channels are covered.
      expect(isGeneratedFile('internal/gen/payrollpb/payroll.pb.go')).toBe(true);
    });

    it('collides the generated layer with the hand-written one by name', () => {
      // A naive scorer sees two BuildPayslips and two Upserts and has no reason
      // to prefer the one that implements the business rule.
      for (const name of ['BuildPayslip', 'Upsert', 'Store']) {
        const files = new Set(cg.getNodesByName(name).map((n) => n.filePath));
        expect([...files].some((p) => p.startsWith(GENERATED_PREFIX)), `${name} generated`).toBe(true);
        expect([...files].some((p) => !p.startsWith(GENERATED_PREFIX)), `${name} hand-written`).toBe(true);
      }
    });

    it('resolves the hand-written workflow chain end-to-end in the graph', () => {
      const calleesOf = (name: string, file: string) => {
        const node = cg.getNodesByName(name).find((n) => n.filePath === file);
        expect(node, `${name} in ${file}`).toBeTruthy();
        return cg
          .getOutgoingEdges(node!.id)
          .filter((e) => e.kind === 'calls')
          .map((e) => cg.getNode(e.target))
          .filter((n): n is NonNullable<typeof n> => !!n);
      };

      // handler → use-case
      expect(
        calleesOf('RunCycle', 'internal/transport/httpapi/payroll_handler.go')
          .some((n) => n.name === 'RunCycle' && n.filePath === 'internal/usecase/payroll/cycle.go'),
      ).toBe(true);

      // use-case → the workflow
      expect(
        calleesOf('RunCycle', 'internal/usecase/payroll/cycle.go')
          .some((n) => n.name === 'runPayrollCycleAll'),
      ).toBe(true);

      // the workflow → build + persist
      const workflow = calleesOf('runPayrollCycleAll', 'internal/usecase/payroll/cycle.go');
      expect(
        workflow.some((n) => n.name === 'BuildPayslip' && n.filePath === 'internal/usecase/payroll/payslip_builder.go'),
        'runPayrollCycleAll must reach the hand-written BuildPayslip',
      ).toBe(true);
      expect(workflow.some((n) => n.name === 'Upsert'), 'runPayrollCycleAll must reach an Upsert').toBe(true);
    });

    it('routes an HTTP entry point into the workflow', () => {
      const router = cg.getNodesInFile('internal/transport/httpapi/router.go');
      expect(router.some((n) => n.kind === 'route' || n.name === 'NewRouter')).toBe(true);
    });

    it('sizes the two layers so the size-driven render split actually bites', () => {
      // The mechanism the epic is about: a small file ships WHOLE, a large one
      // falls through to clipped clusters. The workflow file must stay above the
      // whole-file window and the generated files below it, or the fixture stops
      // reproducing anything.
      const lines = (rel: string) => fs.readFileSync(path.join(testDir, rel), 'utf-8').split('\n').length;
      expect(lines('internal/usecase/payroll/cycle.go')).toBeGreaterThan(220);
      for (const rel of ['internal/gen/fkit/payroll/payslip.go', 'internal/gen/fkit/payroll/payroll_cycle.go']) {
        expect(lines(rel)).toBeLessThan(220);
      }
    });

    it('answers the query at all', () => {
      expect(response.length).toBeGreaterThan(1000);
      expect(bytes.size).toBeGreaterThan(0);
    });
  });

  // ── 2. Budget allocation — the open bug ───────────────────────────────────

  describe('budget allocation', () => {
    const share = (predicate: (p: string) => boolean) => {
      let total = 0;
      for (const [file, n] of bytes) if (predicate(file)) total += n;
      return total / response.length;
    };
    const answerShare = () => share((p) => startsWithAny(p, ANSWER_PREFIXES));
    const generatedShare = () => share((p) => p.startsWith(GENERATED_PREFIX));

    /**
     * BASELINE 2026-08-03 (very-tiny tier, 13,000-char budget): 23,020 chars
     * allocated against it, cut to 16,011 by the 19,500 hard ceiling. The
     * generated CRUD delivers 57.4%; the hand-written layer delivers 25.6%, all
     * of it domain types. `cycle.go` is allocated the single largest slice
     * (7,052 chars, 30.6%) and delivers ZERO — the ceiling drops its whole
     * section — so runPayrollCycleAll, the hand-written BuildPayslip and the
     * real Upsert never reach the agent at all.
     *
     * Each `it.fails` below passes ONLY while that is still true.
     * ⚠ When one goes red, the bug is fixed: remove `.fails`, keep the test.
     */
    it.fails('CG-12 GATE: concentrates the envelope on the hand-written workflow', () => {
      expect(answerShare()).toBeGreaterThanOrEqual(0.55);
    });

    it.fails('CG-12 GATE: does not spend the envelope on the generated CRUD', () => {
      expect(generatedShare()).toBeLessThanOrEqual(0.25);
    });

    it.fails('CG-12 GATE: delivers the workflow file it allocated the most bytes to', () => {
      expect(bytes.get('internal/usecase/payroll/cycle.go') ?? 0).toBeGreaterThan(0);
    });

    it.fails('CG-12 GATE: delivers the calculation the question asks about', () => {
      expect(bytes.get('internal/usecase/payroll/payslip_builder.go') ?? 0).toBeGreaterThan(0);
    });

    it.fails('CG-12 GATE: puts the hand-written chain in the response, not its generated twin', () => {
      // Bare `BuildPayslip`/`Upsert` also match the generated collisions — these
      // needles are unique to the hand-written chain.
      expect(response).toContain('runPayrollCycleAll');
      expect(response).toContain('func (s *Service) BuildPayslip');
      expect(response).toContain('s.store.Upsert(ctx, slip)');
    });

    it('records the shape of the failure so a regression is legible', () => {
      // Not a gate — an assertion-free-ish snapshot of WHY the gates above fail,
      // so a future change that shifts the numbers shows up in the diff rather
      // than silently flipping an it.fails.
      const generated = generatedShare();
      const answer = answerShare();
      const workflow = bytes.get('internal/usecase/payroll/cycle.go') ?? 0;
      expect({
        generatedWinsEnvelope: generated > answer,
        workflowFileDeliversNothing: workflow === 0,
      }).toEqual({
        generatedWinsEnvelope: true,
        workflowFileDeliversNothing: true,
      });
    });
  });
});
