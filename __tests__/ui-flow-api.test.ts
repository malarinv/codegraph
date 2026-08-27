/**
 * `GET /api/flow` — the call path behind the Flow strip (CG-50).
 *
 * Against a real indexed fixture over a real loopback server, like the rest of
 * the viewer's API suite. The fixture is shaped to produce the four things this
 * endpoint has to get right and that a synthetic payload cannot prove:
 *
 * - a real five-hop chain of calls, so the hops, their edges, and the line each
 *   card is opened at all come out of the graph rather than out of a fixture
 *   object,
 * - two definitions of the same name, one of them in a test file, so the
 *   directed search's overload handling and the `ambiguous` report can be
 *   checked (this is the shape that broke `main` on the engine's own index —
 *   the right definition sorted seventh),
 * - a symbol nothing reaches, so "no path" is exercised as the ordinary answer
 *   it is rather than as an error,
 * - a Go interface with one implementation, so a SYNTHESIZED hop — the thing
 *   the strip draws dashed and labels with its wiring site — is a real edge
 *   from the resolver rather than a hand-written metadata blob.
 *
 * The pure geometry is tested without a server in `ui-flow-model.test.ts`.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as http from 'http';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import CodeGraph from '../src/index';
import { createGraphApi, startUiServer, type GraphApi, type UiServerHandle } from '../src/ui-server';
import { flowEdgeLabel, parseFlowQuery } from '../src/ui-server/api/flow';
import { resolveNamedSymbolFlow } from '../src/graph/named-symbol-flow';
import type { Edge } from '../src/types';

let server: UiServerHandle;
let api: GraphApi;
let tempDir: string;
let projectRoot: string;

function request(requestPath: string): Promise<{ status: number; body: string; type?: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port: server.port,
        path: requestPath,
        method: 'GET',
        headers: { Host: `127.0.0.1:${server.port}` },
        setHost: false,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () =>
          resolve({
            status: res.statusCode ?? 0,
            body: Buffer.concat(chunks).toString('utf-8'),
            type: res.headers['content-type'],
          })
        );
      }
    );
    req.on('error', reject);
    req.end();
  });
}

async function getFlow(query: string, expected = 200): Promise<any> {
  const res = await request(`/api/flow${query}`);
  expect(res.type).toBe('application/json; charset=utf-8');
  expect(res.status).toBe(expected);
  return JSON.parse(res.body);
}

function write(root: string, rel: string, body: string): void {
  const full = path.join(root, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, body);
}

/** `name` at each hop, so an assertion reads like the strip does. */
function names(flow: any): string[] {
  return flow.hops.map((h: any) => h.node.name);
}

beforeAll(async () => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-ui-flow-'));
  projectRoot = path.join(tempDir, 'project');

  // A five-hop chain: bootstrap -> handleRequest -> loadRow -> readRow -> toRow.
  write(
    projectRoot,
    'src/main.ts',
    `import { handleRequest } from './server/handler';

export function bootstrap(): string {
  const banner = 'ready';
  return handleRequest(banner);
}
`
  );
  write(
    projectRoot,
    'src/server/handler.ts',
    `import { loadRow } from '../db/rows';

export function handleRequest(id: string): string {
  const trimmed = id.trim();
  return loadRow(trimmed);
}

/** Nothing on the chain calls this — it is the "no path" endpoint. */
export function orphanHandler(): string {
  return 'nobody calls me';
}
`
  );
  write(
    projectRoot,
    'src/db/rows.ts',
    `export function loadRow(id: string): string {
  return readRow(id);
}

function readRow(id: string): string {
  return toRow(id);
}

function toRow(id: string): string {
  return id.toUpperCase();
}
`
  );
  // Two `describe` definitions, one of them in a test file: the ambiguity the
  // directed search has to walk past rather than truncate away.
  write(
    projectRoot,
    'src/db/describe.ts',
    `import { loadRow } from './rows';

export function describeRow(id: string): string {
  return loadRow(id);
}
`
  );
  write(
    projectRoot,
    '__tests__/rows.test.ts',
    `export function describeRow(id: string): string {
  return id;
}
`
  );

  // A Go interface with one implementation: the resolver synthesizes an
  // interface-impl `calls` edge across it, which is what the strip draws dashed.
  write(
    projectRoot,
    'go/clock.go',
    `package clock

type Clock interface {
	Now() string
}

type SystemClock struct{}

func (SystemClock) Now() string {
	return stamp()
}

func stamp() string {
	return "now"
}

func Tick(c Clock) string {
	return c.Now()
}
`
  );

  const cg = CodeGraph.initSync(projectRoot, {
    config: { include: ['src/**/*.ts', '__tests__/**/*.ts', 'go/**/*.go'], exclude: [] },
  });
  await cg.indexAll();
  cg.resolveReferences();
  cg.close();

  const viewerDir = path.join(tempDir, 'viewer');
  fs.mkdirSync(viewerDir, { recursive: true });
  fs.writeFileSync(path.join(viewerDir, 'index.html'), '<!doctype html><div id="app"></div>');

  api = createGraphApi({ projectRoot });
  server = await startUiServer({ projectRoot, viewerDir, port: 0, api: api.handler });
}, 120_000);

afterAll(async () => {
  api?.close();
  await server?.close();
  if (tempDir && fs.existsSync(tempDir)) fs.rmSync(tempDir, { recursive: true, force: true });
});

describe('parseFlowQuery', () => {
  it('reads the three shapes and refuses the empty one', () => {
    expect(parseFlowQuery(new URLSearchParams('from=a&to=b'))).toEqual({
      kind: 'directed',
      from: 'a',
      to: 'b',
    });
    expect(parseFlowQuery(new URLSearchParams('symbols=a,b,c'))).toEqual({
      kind: 'symbols',
      text: 'a,b,c',
    });
    expect(parseFlowQuery(new URLSearchParams('hop=sx&hop=dy&hop=uz'))).toEqual({
      kind: 'trail',
      hops: [
        { id: 'x', dir: 'start' },
        { id: 'y', dir: 'down' },
        { id: 'z', dir: 'up' },
      ],
    });
    expect(() => parseFlowQuery(new URLSearchParams(''))).toThrow(/No flow was asked for/);
  });

  it('refuses a pair that names the same symbol twice', () => {
    expect(() => parseFlowQuery(new URLSearchParams('from=run&to=run'))).toThrow(/same symbol/);
  });

  it('takes a trail over a from/to pair, and refuses a one-hop trail', () => {
    // A hop parameter is only ever sent by "Read as flow", which is a complete
    // question on its own; a stray `from` alongside it must not be searched.
    const parsed = parseFlowQuery(new URLSearchParams('from=a&to=b&hop=sx&hop=dy'));
    expect(parsed.kind).toBe('trail');
    expect(() => parseFlowQuery(new URLSearchParams('hop=sx'))).toThrow(/at least two hops/);
  });
});

describe('flowEdgeLabel', () => {
  const edge = (metadata: Record<string, unknown>, provenance = 'heuristic'): Edge =>
    ({ kind: 'calls', source: 'a', target: 'b', provenance, metadata }) as unknown as Edge;

  it('names the mechanism and the wiring site for a synthesized hop', () => {
    expect(
      flowEdgeLabel(edge({ synthesizedBy: 'callback', registeredAt: 'src/a.ts:12' }), false)
    ).toBe('via callback · registered at src/a.ts:12');
  });

  it('never lets a synthesized hop read as a plain call', () => {
    expect(flowEdgeLabel(edge({ synthesizedBy: 'react-render' }), false)).toBe('via react render');
  });

  it('says "called by" when the reader walked the edge backwards', () => {
    expect(flowEdgeLabel(edge({}, 'resolved'), true)).toBe('called by');
    expect(flowEdgeLabel(edge({}, 'resolved'), false)).toBe('calls');
  });
});

describe('GET /api/flow — a directed question', () => {
  it('returns the whole chain, one hop per card', async () => {
    const payload = await getFlow('?from=bootstrap&to=toRow');
    expect(payload.query).toMatchObject({ kind: 'directed', from: 'bootstrap', to: 'toRow' });
    expect(payload.reason).toBeNull();
    expect(payload.flows).toHaveLength(1);
    expect(names(payload.flows[0])).toEqual([
      'bootstrap',
      'handleRequest',
      'loadRow',
      'readRow',
      'toRow',
    ]);
    expect(payload.flows[0].label).toBe('bootstrap → toRow');
  });

  it('opens each card at the line that calls the next one', async () => {
    const { flows } = await getFlow('?from=bootstrap&to=toRow');
    const hops = flows[0].hops;
    for (let i = 0; i < hops.length - 1; i++) {
      const ref = hops[i].callRef;
      expect(ref, `hop ${i} has a call site`).not.toBeNull();
      expect(ref.name).toBe(hops[i + 1].node.name);
      expect(ref.targetId).toBe(hops[i + 1].node.id);
      expect(ref.backwards).toBe(false);
      // The window is centred on it, and the source really contains it.
      expect(ref.line).toBeGreaterThanOrEqual(hops[i].source.from);
      expect(ref.line).toBeLessThanOrEqual(hops[i].source.to);
      const offset = ref.line - hops[i].source.from;
      expect(hops[i].source.lines[offset]).toContain(hops[i + 1].node.name);
    }
    // The last card has nothing to call, so it opens at its own definition.
    const last = hops[hops.length - 1];
    expect(last.callRef).toBeNull();
    expect(last.source.from).toBeLessThanOrEqual(last.node.line);
    expect(last.source.to).toBeGreaterThanOrEqual(last.node.line);
  });

  it('carries the edge on every hop but the first, with its line', async () => {
    const { flows } = await getFlow('?from=bootstrap&to=toRow');
    const hops = flows[0].hops;
    expect(hops[0].edge).toBeNull();
    for (let i = 1; i < hops.length; i++) {
      expect(hops[i].edge.kind).toBe('calls');
      expect(hops[i].edge.label).toBe('calls');
      expect(hops[i].edge.upward).toBe(false);
      expect(hops[i].edge.synthesized).toBe(false);
      // The edge's line is the previous card's call site — the two agree, and
      // the strip prints both, so a disagreement would be visible.
      expect(hops[i].edge.line).toBe(hops[i - 1].callRef.line);
    }
  });

  it('highlights each card with real source, never a drifted slice', async () => {
    const { flows } = await getFlow('?from=bootstrap&to=toRow');
    for (const hop of flows[0].hops) {
      expect(hop.source.drift).toBe(false);
      expect(hop.source.lines.length).toBeGreaterThan(0);
      expect(hop.source.lines.length).toBe(hop.source.to - hop.source.from + 1);
      // Highlight rides with the slice and is line-for-line with it (CG-43).
      expect(hop.source.highlight.lines).toHaveLength(hop.source.lines.length);
    }
  });

  it('answers "not connected" as an ordinary answer, with a reason', async () => {
    const payload = await getFlow('?from=bootstrap&to=orphanHandler');
    expect(payload.flows).toEqual([]);
    expect(payload.reason).toMatch(/No chain of calls reaches orphanHandler/);
    expect(payload.reason).toMatch(/dynamic dispatch/);
    expect(payload.unresolved).toEqual([]);
  });

  it('says which names matched nothing rather than blaming the path', async () => {
    const payload = await getFlow('?from=bootstrap&to=thisNameIsNotHere');
    expect(payload.unresolved).toEqual(['thisNameIsNotHere']);
    expect(payload.reason).toMatch(/thisNameIsNotHere names nothing/);
  });

  it('walks past an overload in a test file and reports the ambiguity', async () => {
    const payload = await getFlow('?from=describeRow&to=toRow');
    expect(names(payload.flows[0])).toEqual(['describeRow', 'loadRow', 'readRow', 'toRow']);
    const ambiguity = payload.ambiguous.find((a: any) => a.token === 'describeRow');
    expect(ambiguity).toBeDefined();
    expect(ambiguity.chosen.file).toBe('src/db/describe.ts');
    expect(ambiguity.others.map((o: any) => o.file)).toContain('__tests__/rows.test.ts');
  });
});

describe('GET /api/flow — a synthesized hop', () => {
  it('draws the interface bridge as a dashed hop that names its mechanism', async () => {
    const payload = await getFlow('?from=Tick&to=stamp');
    expect(payload.flows.length).toBeGreaterThan(0);
    const hops = payload.flows[0].hops;
    expect(names(payload.flows[0])[0]).toBe('Tick');
    expect(names(payload.flows[0]).at(-1)).toBe('stamp');
    const synthesized = hops.filter((h: any) => h.edge?.synthesized);
    expect(synthesized.length).toBeGreaterThan(0);
    for (const hop of synthesized) {
      expect(hop.edge.provenance).toBe('heuristic');
      expect(hop.edge.label).toMatch(/^via /);
      expect(hop.edge.label).not.toBe('calls');
    }
  });
});

describe('GET /api/flow — explore parity', () => {
  it('answers a ?symbols= question with the chain the explore search finds', async () => {
    const payload = await getFlow('?symbols=bootstrap,loadRow,toRow');
    expect(payload.query.kind).toBe('symbols');
    expect(payload.flows.length).toBeGreaterThan(0);

    // The endpoint must not have its own path finder. Run the engine's directly
    // and require the same hops, in the same order.
    const cg = CodeGraph.openSync(projectRoot);
    try {
      const flow = resolveNamedSymbolFlow(cg, 'bootstrap,loadRow,toRow');
      expect(flow.chains[0]?.steps.map((s) => s.node.id)).toEqual(
        payload.flows[0].hops.map((h: any) => h.node.id)
      );
    } finally {
      cg.close();
    }
  });
});

describe('GET /api/flow — a trail read as a flow', () => {
  it('draws the hops it was given, finding the edge that already joins them', async () => {
    const forward = await getFlow('?from=bootstrap&to=toRow');
    const ids: string[] = forward.flows[0].hops.map((h: any) => h.node.id);
    const query = ids
      .map((id, i) => `hop=${encodeURIComponent(`${i === 0 ? 's' : 'd'}${id}`)}`)
      .join('&');

    const payload = await getFlow(`?${query}`);
    expect(payload.query.kind).toBe('trail');
    expect(payload.flows[0].hops.map((h: any) => h.node.id)).toEqual(ids);
    expect(payload.flows[0].hops[1].edge.kind).toBe('calls');
    expect(payload.flows[0].hops[1].edge.upward).toBe(false);
  });

  it('reads a trail walked BACKWARDS as caller hops, opened at the calling line', async () => {
    const forward = await getFlow('?from=bootstrap&to=toRow');
    const ids: string[] = forward.flows[0].hops.map((h: any) => h.node.id).reverse();
    const query = ids
      .map((id, i) => `hop=${encodeURIComponent(`${i === 0 ? 's' : 'u'}${id}`)}`)
      .join('&');

    const payload = await getFlow(`?${query}`);
    const hops = payload.flows[0].hops;
    expect(hops.map((h: any) => h.node.id)).toEqual(ids);
    // Every hop after the first is the caller of the one before it, so its own
    // body holds the call — and the card opens there, pointing BACK.
    for (let i = 1; i < hops.length; i++) {
      expect(hops[i].edge.upward).toBe(true);
      expect(hops[i].edge.label).toBe('called by');
      expect(hops[i].callRef.backwards).toBe(true);
      expect(hops[i].callRef.name).toBe(hops[i - 1].node.name);
      expect(hops[i].callRef.line).toBe(hops[i].edge.line);
    }
    // The first card is the callee: nothing in it calls anything on this trail.
    expect(hops[0].callRef).toBeNull();
  });

  it('says so when the ids on a trail are no longer in the index', async () => {
    const payload = await getFlow('?hop=smethod%3Agone&hop=dmethod%3Aalso-gone');
    expect(payload.flows).toEqual([]);
    expect(payload.unresolved).toEqual(['method:gone', 'method:also-gone']);
    expect(payload.reason).toMatch(/still in the index/);
  });
});

describe('GET /api/flow — refusals', () => {
  it('answers JSON, not text, when the question is malformed', async () => {
    const payload = await getFlow('', 400);
    expect(payload.code).toBe('bad-request');
    expect(payload.error).toMatch(/No flow was asked for/);
    expect(payload.hint).toMatch(/\?from=/);
  });

  it('caps the number of trail hops it will read', async () => {
    const query = Array.from({ length: 40 }, (_, i) => `hop=s${i}xx`).join('&');
    const payload = await getFlow(`?${query}`, 400);
    expect(payload.code).toBe('bad-request');
    expect(payload.error).toMatch(/longer than this endpoint reads/);
  });

  it('is listed on the API index', async () => {
    const res = await request('/api');
    const body = JSON.parse(res.body);
    const entry = body.endpoints.find((e: any) => e.path === '/api/flow');
    expect(entry).toBeDefined();
    expect(entry.params).toContain('from');
    expect(entry.params).toContain('hop');
  });
});
