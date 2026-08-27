/**
 * The Map's layout, without a browser (CG-49).
 *
 * The properties under test are the ones that make the picture mean something.
 * A map is only worth reading if the vertical position of a box is a claim
 * about the code — so the tests here are mostly about *why* a module ends up
 * where it does:
 *
 * - the layering rests on `declared` weight, not raw counts, because bare name
 *   matching invents cross-module links out of shared method names;
 * - a two-cycle keeps its heavier direction and the lighter one is reported,
 *   never quietly dropped;
 * - the same payload always produces the same picture, because a diagram you
 *   cannot recognise between two visits is not a map of anything.
 *
 * The endpoint that feeds it is tested against a real index in
 * `ui-map-api.test.ts`.
 */

import { describe, it, expect } from 'vitest';
import {
  buildMapLayout,
  isEdgeVisible,
  linkId,
  moduleMetaLabel,
  nodeWidth,
  strokeWidthFor,
  LAYER_GAP,
  MIN_WEIGHT,
  MIN_WEIGHT_WITH_TESTS,
  NODE_HEIGHT,
  type MapLayout,
} from '../ui/src/lib/map-model';
import type { WireMapLink, WireMapModule } from '../ui/src/lib/api';

/* ------------------------------------------------------------- fixtures -- */

function mod(id: string, over: Partial<WireMapModule> = {}): WireMapModule {
  return {
    id,
    label: id.slice(id.lastIndexOf('/') + 1) || id,
    files: over.files ?? 3,
    symbols: over.symbols ?? 30,
    languages: over.languages ?? [{ language: 'typescript', files: over.files ?? 3 }],
    test: over.test ?? false,
    facade: over.facade ?? false,
    fileList: over.fileList ?? { total: 3, shown: 3, truncated: false, items: [] },
  };
}

function link(
  source: string,
  target: string,
  count: number,
  declared = count
): WireMapLink {
  return {
    source,
    target,
    count,
    declared,
    byKind: [{ kind: 'calls', count }],
    topPairs: [],
  };
}

function layerOf(layout: MapLayout, id: string): number {
  const node = layout.nodes.find((n) => n.id === id);
  expect(node, `no node ${id}`).toBeTruthy();
  return node!.layer;
}

const OPTS = { includeTests: false };

/* ---------------------------------------------------------------- specs -- */

describe('nodeWidth', () => {
  it('fits the wider of the two lines and never goes under the floor', () => {
    expect(nodeWidth('ui')).toBe(110);
    // A long id outgrows the floor; a long meta line outgrows a short id.
    expect(nodeWidth('src/resolution/(root files)')).toBeGreaterThan(200);
    expect(nodeWidth('src/db', '1218 symbols · 54 files')).toBeGreaterThan(nodeWidth('src/db'));
  });
});

describe('moduleMetaLabel', () => {
  it('says the counts in singular when there is one of them', () => {
    expect(moduleMetaLabel(mod('src/x', { symbols: 1, files: 1 }))).toBe('1 symbol · 1 file');
    expect(moduleMetaLabel(mod('src/x', { symbols: 9, files: 2 }))).toBe('9 symbols · 2 files');
  });
});

describe('strokeWidthFor', () => {
  it('grows with the logarithm of the count and stops at 6', () => {
    expect(strokeWidthFor(1)).toBe(1);
    expect(strokeWidthFor(700)).toBeLessThanOrEqual(6);
    expect(strokeWidthFor(1_000_000)).toBe(6);
    expect(strokeWidthFor(64)).toBeGreaterThan(strokeWidthFor(8));
    // A count of zero must not produce -Infinity.
    expect(Number.isFinite(strokeWidthFor(0))).toBe(true);
  });
});

describe('layering', () => {
  const modules = [mod('src/bin'), mod('src/core'), mod('src/db')];

  it('puts a module one layer above everything it depends on', () => {
    const layout = buildMapLayout(
      { modules, links: [link('src/bin', 'src/core', 10), link('src/core', 'src/db', 10)] },
      OPTS
    );
    expect(layerOf(layout, 'src/db')).toBe(0);
    expect(layerOf(layout, 'src/core')).toBe(1);
    expect(layerOf(layout, 'src/bin')).toBe(2);
    // Layer 0 is the foundations, and it is drawn at the BOTTOM.
    const bin = layout.nodes.find((n) => n.id === 'src/bin')!;
    const db = layout.nodes.find((n) => n.id === 'src/db')!;
    expect(bin.y).toBeLessThan(db.y);
    expect(db.y - bin.y).toBe(2 * (NODE_HEIGHT + LAYER_GAP));
  });

  it('names only the top and bottom layers', () => {
    const layout = buildMapLayout(
      { modules, links: [link('src/bin', 'src/core', 10), link('src/core', 'src/db', 10)] },
      OPTS
    );
    expect(layout.layers.map((l) => l.label)).toEqual([
      'foundations — depend on nothing below',
      null,
      'entry points',
    ]);
  });

  it('ignores a link with nothing declared behind it', () => {
    // `src/db -> src/bin` is 40 name-only matches (`run`, `push`, `finish`) and
    // would otherwise lift the storage layer above the CLI. It is still drawn —
    // as a back-edge — but it must not decide the vertical order.
    const layout = buildMapLayout(
      {
        modules,
        links: [
          link('src/bin', 'src/core', 10, 10),
          link('src/core', 'src/db', 10, 10),
          link('src/db', 'src/bin', 40, 0),
        ],
      },
      OPTS
    );
    expect(layout.basis.kind).toBe('declared');
    expect(layerOf(layout, 'src/db')).toBe(0);
    expect(layerOf(layout, 'src/bin')).toBe(2);
    const noisy = layout.edges.find((e) => e.source === 'src/db' && e.target === 'src/bin')!;
    expect(noisy).toBeTruthy();
    expect(noisy.back).toBe(true);
  });

  it('falls back to raw counts, and says so, when almost nothing is declared', () => {
    const layout = buildMapLayout(
      {
        modules,
        links: [
          link('src/bin', 'src/core', 10, 0),
          link('src/core', 'src/db', 10, 0),
          link('src/db', 'src/core', 2, 1),
        ],
      },
      OPTS
    );
    expect(layout.basis.kind).toBe('all');
    expect(layout.basis.declaredLinks).toBe(1);
    expect(layout.basis.totalLinks).toBe(3);
    expect(layout.basis.declaredLinks / layout.basis.totalLinks).toBeLessThan(0.4);
    // With raw counts the chain is still a chain, and the light back-reference
    // becomes the mutual one.
    expect(layerOf(layout, 'src/db')).toBe(0);
    expect(layerOf(layout, 'src/bin')).toBe(2);
    expect(layout.mutual.map((m) => m.back.source)).toEqual(['src/db']);
  });

  it('survives a three-module loop instead of recursing forever', () => {
    const layout = buildMapLayout(
      {
        modules,
        links: [
          link('src/bin', 'src/core', 5),
          link('src/core', 'src/db', 5),
          link('src/db', 'src/bin', 5),
        ],
      },
      OPTS
    );
    expect(layout.nodes).toHaveLength(3);
    expect(layout.moduleCycles).toEqual([['src/bin', 'src/core', 'src/db']]);
    // Every module still got a finite layer.
    expect(layout.nodes.every((n) => Number.isInteger(n.layer))).toBe(true);
  });
});

describe('two-cycles', () => {
  const modules = [mod('src/a'), mod('src/b')];

  it('keeps the heavier direction and reports the lighter as mutual', () => {
    const layout = buildMapLayout(
      { modules, links: [link('src/a', 'src/b', 20), link('src/b', 'src/a', 3)] },
      OPTS
    );
    expect(layerOf(layout, 'src/a')).toBe(1);
    expect(layerOf(layout, 'src/b')).toBe(0);
    expect(layout.mutual).toHaveLength(1);
    expect(layout.mutual[0]!.forward.source).toBe('src/a');
    expect(layout.mutual[0]!.back.source).toBe('src/b');
    // Both directions are still on the canvas; the lighter one points up.
    expect(layout.edges).toHaveLength(2);
    expect(layout.edges.find((e) => e.source === 'src/b')!.back).toBe(true);
    expect(layout.edges.find((e) => e.source === 'src/a')!.back).toBe(false);
  });

  it('breaks an exact tie the same way every time', () => {
    const one = buildMapLayout(
      { modules, links: [link('src/a', 'src/b', 7), link('src/b', 'src/a', 7)] },
      OPTS
    );
    const two = buildMapLayout(
      { modules, links: [link('src/b', 'src/a', 7), link('src/a', 'src/b', 7)] },
      OPTS
    );
    expect(one.mutual[0]!.back.source).toBe('src/b');
    expect(two.mutual[0]!.back.source).toBe('src/b');
    expect(layerOf(one, 'src/a')).toBe(layerOf(two, 'src/a'));
  });
});

describe('tests and thresholds', () => {
  const modules = [mod('src/core'), mod('__tests__', { test: true })];
  const links = [link('__tests__', 'src/core', 30), link('src/core', '__tests__', 2)];

  it('leaves test modules out until they are asked for, and their links with them', () => {
    const off = buildMapLayout({ modules, links }, { includeTests: false });
    expect(off.nodes.map((n) => n.id)).toEqual(['src/core']);
    expect(off.edges).toHaveLength(0);
    expect(off.minWeight).toBe(MIN_WEIGHT);

    const on = buildMapLayout({ modules, links }, { includeTests: true });
    expect(on.nodes).toHaveLength(2);
    expect(on.edges).toHaveLength(2);
    // A test module touches everything, so the bar for a visible link is higher.
    expect(on.minWeight).toBe(MIN_WEIGHT_WITH_TESTS);
  });

  it('marks a link under the threshold thin rather than deleting it', () => {
    const layout = buildMapLayout(
      {
        modules: [mod('src/a'), mod('src/b'), mod('src/c')],
        links: [link('src/a', 'src/b', 12), link('src/a', 'src/c', 2)],
      },
      OPTS
    );
    const thin = layout.edges.find((e) => e.target === 'src/c')!;
    expect(thin.thin).toBe(true);
    expect(isEdgeVisible(thin, null)).toBe(false);
    // Selecting either end brings it back — that is the whole point of hiding
    // it rather than dropping it.
    expect(isEdgeVisible(thin, 'src/a')).toBe(true);
    expect(isEdgeVisible(thin, 'src/c')).toBe(true);
    expect(isEdgeVisible(thin, 'src/b')).toBe(false);

    const fat = layout.edges.find((e) => e.target === 'src/b')!;
    expect(isEdgeVisible(fat, null)).toBe(true);
    expect(isEdgeVisible(fat, 'src/c')).toBe(false);
  });
});

describe('ports', () => {
  it('gives every link its own port, ordered by where the other end sits', () => {
    const layout = buildMapLayout(
      {
        modules: [mod('src/top'), mod('src/left'), mod('src/mid'), mod('src/right')],
        links: [
          link('src/top', 'src/left', 9),
          link('src/top', 'src/mid', 9),
          link('src/top', 'src/right', 9),
        ],
      },
      OPTS
    );
    const top = layout.nodes.find((n) => n.id === 'src/top')!;
    expect(top.sourceHandles).toHaveLength(3);
    expect(new Set(top.sourceHandles).size).toBe(3);

    // The handle order must follow the targets' left-to-right order, or the
    // three edges cross each other inside the gap for no reason.
    const xOf = (id: string) => {
      const n = layout.nodes.find((m) => m.id === id)!;
      return n.x + n.width / 2;
    };
    const targets = top.sourceHandles.map(
      (id) => layout.edges.find((e) => e.id === id)!.target
    );
    const xs = targets.map(xOf);
    expect(xs).toEqual([...xs].sort((a, b) => a - b));

    // Each target's single incoming link is its only target handle.
    for (const id of ['src/left', 'src/mid', 'src/right']) {
      expect(layout.nodes.find((n) => n.id === id)!.targetHandles).toHaveLength(1);
    }
  });

  it('names an edge by its endpoints, so two runs key the same', () => {
    expect(linkId({ source: 'a', target: 'b' })).toBe(linkId({ source: 'a', target: 'b' }));
    expect(linkId({ source: 'a', target: 'b' })).not.toBe(linkId({ source: 'b', target: 'a' }));
  });
});

describe('determinism', () => {
  const modules = [
    mod('src/alpha'),
    mod('src/beta'),
    mod('src/gamma'),
    mod('src/delta'),
    mod('src/epsilon'),
  ];
  const links = [
    link('src/alpha', 'src/beta', 12),
    link('src/alpha', 'src/gamma', 8),
    link('src/beta', 'src/delta', 15),
    link('src/gamma', 'src/delta', 6),
    link('src/delta', 'src/epsilon', 20),
    link('src/beta', 'src/epsilon', 5),
  ];

  it('produces an identical layout from an identical payload', () => {
    const a = buildMapLayout({ modules, links }, OPTS);
    const b = buildMapLayout({ modules, links }, OPTS);
    expect(JSON.stringify(b)).toBe(JSON.stringify(a));
  });

  it('does not depend on the order the payload happened to arrive in', () => {
    const a = buildMapLayout({ modules, links }, OPTS);
    const b = buildMapLayout(
      { modules: [...modules].reverse(), links: [...links].reverse() },
      OPTS
    );
    const positions = (l: MapLayout) =>
      l.nodes
        .map((n) => `${n.id}@${n.layer}:${Math.round(n.x)},${Math.round(n.y)}`)
        .sort()
        .join('|');
    expect(positions(b)).toBe(positions(a));
  });

  it('places an unconnected module without stretching the canvas around it', () => {
    const withIsland = buildMapLayout(
      { modules: [...modules, mod('src/island')], links },
      OPTS
    );
    const island = withIsland.nodes.find((n) => n.id === 'src/island')!;
    expect(island).toBeTruthy();
    expect(island.layer).toBe(0);
    // Parked at the right-hand end of its layer, not interleaved through the
    // modules that actually connect.
    const sameLayer = withIsland.nodes.filter((n) => n.layer === 0);
    expect(Math.max(...sameLayer.map((n) => n.x))).toBe(island.x);
    // And the canvas is no wider than the boxes standing shoulder to shoulder.
    const widest = Math.max(
      ...[0, 1, 2, 3].map((layer) =>
        withIsland.nodes
          .filter((n) => n.layer === layer)
          .reduce((sum, n) => sum + n.width, 0)
      )
    );
    expect(withIsland.width).toBeLessThan(widest + 6 * 34 + 200);
  });
});

describe('empty and degenerate inputs', () => {
  it('answers an empty payload without throwing', () => {
    const layout = buildMapLayout({ modules: [], links: [] }, OPTS);
    expect(layout.nodes).toHaveLength(0);
    expect(layout.edges).toHaveLength(0);
    expect(layout.basis.kind).toBe('all');
    expect(Number.isFinite(layout.width)).toBe(true);
    expect(Number.isFinite(layout.height)).toBe(true);
  });

  it('drops a link whose other end was filtered out', () => {
    const layout = buildMapLayout(
      {
        modules: [mod('src/a'), mod('__tests__', { test: true })],
        links: [link('src/a', '__tests__', 9), link('src/a', 'src/ghost', 9)],
      },
      OPTS
    );
    expect(layout.edges).toHaveLength(0);
  });

  it('leaves a single layer unlabelled', () => {
    const layout = buildMapLayout({ modules: [mod('src/only')], links: [] }, OPTS);
    expect(layout.layers).toHaveLength(1);
    expect(layout.layers[0]!.label).toBeNull();
  });
});
