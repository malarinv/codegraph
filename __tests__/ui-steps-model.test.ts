/**
 * The Steps view's model, without a browser: rows by the server's depth, the
 * words in a box by kind, one edge per pair with the Screens view's label
 * rule, and the panel's two lists.
 */
import { describe, it, expect } from 'vitest';
import { buildStepsModel, kindWord, stepLabel, stepNeighbourhood, stepSub, stepViaText } from '../ui/src/lib/steps-model';
import { placeLabels } from '../ui/src/lib/screens-model';
import type { WireNodeRef, WireStep, WireStepLink, WireStepsPayload } from '../ui/src/lib/wire';

function ref(name: string, file = 'src/a.tsx', language: WireNodeRef['language'] = 'tsx'): WireNodeRef {
  return { id: `function:${name}`, kind: 'function', name, qualifiedName: name, file, line: 1, endLine: 9, language, test: false };
}

function step(label: string, kind: WireStep['kind'], depth: number, extra: Partial<WireStep> = {}): WireStep {
  const node = kind === 'effect' ? null : ref(label, extra.node?.file ?? 'src/a.tsx');
  return { id: node?.id ?? `effect:fn:${label}`, kind, anchor: depth === 0, node, label, sub: 'src/a.tsx', depth, cut: null, ...extra };
}

function link(from: WireStep, to: WireStep, extra: Partial<WireStepLink> = {}): WireStepLink {
  return { id: `${from.id} ${to.id}`, from: from.id, to: to.id, kind: 'calls', via: [], when: '', label: '', synthesized: false, uncertain: false, sites: [], ...extra };
}

function payload(steps: WireStep[], links: WireStepLink[]): WireStepsPayload {
  return {
    anchor: steps[0]!.node!,
    ambiguous: [],
    steps,
    links,
    depth: 8,
    limit: 120,
    through: false,
    truncated: { steps: 0, hubs: 0, chrome: 0 },
    index: { lastIndexedAt: null, edges: 0, files: 0 },
    timing: { elapsedMs: 1 },
  };
}

describe('steps model', () => {
  const screen = step('/capture/review', 'screen', 0, { screen: { path: '/capture/review', component: ref('ReviewScreen') } });
  const handler = step('handleApprove', 'trigger', 1);
  const bridge = step('finalizeCaptureSession', 'bridge', 2, { node: ref('finalizeCaptureSession', 'ios/CaptureView.swift', 'swift') });
  const event = step('handleZipComplete', 'event', 3, { event: 'onZipComplete' });
  const effect = step('client.post', 'effect', 4, { sub: 'network · uploadARCapture', effect: { api: 'client.post', apis: ['client.post'], category: 'network', by: ref('uploadARCapture'), line: 3 } });
  const store = step('setZipUri', 'store', 4, { node: ref('setZipUri', 'src/storage/capture.storage.ts') });
  const home = step('/', 'screen', 4, { screen: { path: '/', component: null } });
  const links = [
    link(screen, handler, { kind: 'handler' }),
    link(handler, bridge, { kind: 'bridge', when: '!busy' }),
    link(bridge, event, { kind: 'event', synthesized: true, via: [ref('emitZipComplete', 'ios/CaptureEvents.swift', 'swift')], when: 'result', label: 'via rn-event-channel · event onZipComplete' }),
    link(event, effect, { kind: 'effect', via: [ref('uploadARCapture')] }),
    link(event, store, { kind: 'store' }),
    link(event, home, { kind: 'navigates', when: 'unlimited' }),
    // A second way from the event to the store, unconditional: the pair is one edge saying "2 ways".
    { ...link(event, store, { kind: 'store', when: 'retry' }), id: 'second' },
  ];
  const model = buildStepsModel(payload([screen, handler, bridge, event, effect, store, home], links));

  it('puts the anchor on top and each row one step further away', () => {
    const y = (id: string) => model.layout.nodes.find((n) => n.id === id)!.y;
    expect(y(screen.id)).toBeLessThan(y(handler.id));
    expect(y(handler.id)).toBeLessThan(y(bridge.id));
    expect(y(bridge.id)).toBeLessThan(y(event.id));
    expect(y(event.id)).toBeLessThan(y(effect.id));
    expect(y(effect.id)).toBe(y(store.id));
    expect(y(effect.id)).toBe(y(home.id));
  });

  it('one edge per pair, labelled with the innermost condition or a count', () => {
    const edges = [...model.edges.values()];
    expect(edges).toHaveLength(6);
    const toBridge = edges.find((e) => e.to === bridge.id)!;
    expect(toBridge.label).toBe('!busy');
    expect(toBridge.kind).toBe('bridge');
    const toEvent = edges.find((e) => e.to === event.id)!;
    expect(toEvent.synthesized).toBe(true);
    expect(toEvent.label).toBe('result');
    const toStore = edges.find((e) => e.to === store.id)!;
    expect(toStore.links).toHaveLength(2);
    expect(toStore.label).toBe('2 ways · 1 conditional');
    expect(toStore.kind).toBe('store');
  });

  it('counts steps per kind', () => {
    expect(model.counts).toEqual({ anchor: 0, screen: 2, trigger: 1, bridge: 1, event: 1, store: 1, effect: 1 });
  });

  it('words a box by its kind', () => {
    expect(stepLabel(bridge)).toBe('⇢ finalizeCaptureSession');
    expect(stepLabel(event)).toBe('⇠ onZipComplete');
    expect(stepLabel({ ...event, events: ['onZipComplete', 'onZipError', 'onCameraReady'] })).toBe('⇠ onZipComplete +2');
    expect(stepLabel(screen)).toBe('/capture/review');
    expect(stepSub(event)).toBe('handleZipComplete · a.tsx');
    expect(stepSub(bridge)).toBe('native · CaptureView.swift');
    expect(stepSub(store)).toBe('store · capture.storage.ts');
    expect(stepSub(effect)).toBe('network · uploadARCapture');
    expect(kindWord('effect')).toBe('outside the index');
    expect(stepViaText(links[2]!)).toBe('emitZipComplete');
  });

  it('labels a selected step at the far end of each line, and lists its links', () => {
    const pills = placeLabels(model, event.id);
    expect(pills.hidden).toBe(0);
    const words = [...pills.pills.values()].map((p) => p.text).sort();
    expect(words).toEqual(['← result', '→ 2 ways · 1 conditional', '→ unlimited']);
    const lists = stepNeighbourhood(payload([screen, handler, bridge, event, effect, store, home], links), event.id);
    expect(lists.arrivesFrom.map((l) => l.from)).toEqual([bridge.id]);
    expect(lists.leadsTo.map((l) => l.to)).toEqual([effect.id, store.id, home.id, store.id]);
  });
});
