/**
 * `GET /api/steps` — what happens from a screen, as typed steps.
 *
 * Against a real index of a small Expo + React Native app, shaped to cross
 * every boundary the endpoint classifies: a screen whose handler (a
 * `useCallback`) calls a Swift method through an `RCT_EXTERN_MODULE` shim,
 * the Swift side sending an event the screen listens to, the listener calling
 * an API function that leaves the index (`client.post`), a store action in a
 * store file, and a navigation to a second screen behind a condition. The
 * pure layout is tested without an index in `ui-steps-model.test.ts`.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CodeGraph } from '../src';
import { initGrammars, loadAllGrammars } from '../src/extraction/grammars';
import { buildSteps, crossing, effectCategory, isStoreFile } from '../src/ui-server/api/steps';

let tmpDir: string;
let cg: CodeGraph;

function write(rel: string, content: string): void {
  const full = path.join(tmpDir, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
}

beforeAll(async () => {
  await initGrammars();
  await loadAllGrammars();
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-ui-steps-'));
  write('package.json', JSON.stringify({ name: 'app', dependencies: { expo: '52', 'expo-router': '4', 'react-native': '0.76' } }));
  write('src/app/_layout.tsx', 'export default function Layout() { return null }\n');
  write('src/app/index.tsx', "import { router } from 'expo-router'\nexport default function Home() {\n  return null\n}\n");
  write(
    'src/components/capture/capture-view.tsx',
    "import { NativeModules, NativeEventEmitter } from 'react-native'\n" +
      'export const captureView = NativeModules.CaptureView\n' +
      'export const nativeEmitter = new NativeEventEmitter(NativeModules.CaptureEvents)\n'
  );
  write('src/api/client.ts', "import axios from 'axios'\nexport const client = axios.create({ baseURL: 'x' })\n");
  write(
    'src/api/frames.ts',
    "import { client } from './client'\n" +
      'export async function uploadARCapture(uri: string) {\n' +
      "  await client.post('/frames', { uri })\n" +
      "  return client.get('/frames/status')\n" +
      '}\n'
  );
  write(
    'src/storage/capture.storage.ts',
    "import { create } from 'zustand'\n" +
      'const useCaptureStorage = create<State>((set) => ({\n' +
      '  zipUri: null,\n' +
      '  setZipUri: (zipUri: string) => set({ zipUri }),\n' +
      '}))\n' +
      'export default useCaptureStorage\n'
  );
  write(
    'src/app/capture/review.tsx',
    "import { useCallback, useEffect } from 'react'\n" +
      "import { router } from 'expo-router'\n" +
      "import { captureView, nativeEmitter } from '../../components/capture/capture-view'\n" +
      "import { uploadARCapture } from '../../api/frames'\n" +
      "import useCaptureStorage from '../../storage/capture.storage'\n" +
      'export default function ReviewScreen({ unlimited }: { unlimited: boolean }) {\n' +
      '  const setZipUri = useCaptureStorage((s) => s.setZipUri)\n' +
      '  const handleApprove = useCallback(() => {\n' +
      '    captureView.finalizeCaptureSession()\n' +
      '  }, [])\n' +
      '  const handleZipComplete = useCallback(async (data: { uri: string }) => {\n' +
      '    setZipUri(data.uri)\n' +
      '    await uploadARCapture(data.uri)\n' +
      "    Alert.alert('Uploaded', data.uri, [{ text: 'OK' }])\n" +
      "    if (unlimited) router.replace('/')\n" +
      '  }, [unlimited])\n' +
      '  useEffect(() => {\n' +
      "    const sub = nativeEmitter.addListener('onZipComplete', handleZipComplete)\n" +
      '    return () => sub.remove()\n' +
      '  }, [handleZipComplete])\n' +
      '  return <Button onPress={handleApprove} />\n' +
      '}\n'
  );
  write(
    'src/app/capture/index.tsx',
    "import { memo, useCallback } from 'react'\n" +
      "import { captureView } from '../../components/capture/capture-view'\n" +
      'function CaptureComponent() {\n' +
      '  const handleOpen = useCallback(() => {\n' +
      '    captureView.finalizeCaptureSession()\n' +
      '  }, [])\n' +
      '  return <Button onPress={handleOpen} />\n' +
      '}\n' +
      'const MemoizedCaptureComponent = memo(CaptureComponent)\n' +
      'export default function CapturePage() {\n' +
      '  return <MemoizedCaptureComponent />\n' +
      '}\n'
  );
  write(
    'ios/CaptureView.m',
    '#import <React/RCTViewManager.h>\n@interface RCT_EXTERN_MODULE(CaptureView, RCTViewManager)\nRCT_EXTERN_METHOD(finalizeCaptureSession)\n@end\n'
  );
  write(
    'ios/CaptureView.swift',
    'import Foundation\n' +
      'class CaptureView: RCTViewManager {\n' +
      '  @objc func finalizeCaptureSession() {\n' +
      '    let result = zip()\n' +
      '    if result {\n' +
      '      CaptureEvents.shared.emitZipComplete()\n' +
      '    }\n' +
      '  }\n' +
      '  func zip() -> Bool { return true }\n' +
      '}\n'
  );
  write(
    'ios/CaptureEvents.swift',
    'import Foundation\n' +
      'class CaptureEvents: RCTEventEmitter {\n' +
      '  static let shared = CaptureEvents()\n' +
      '  func emitZipComplete() {\n' +
      '    sendEvent(withName: "onZipComplete", body: nil)\n' +
      '  }\n' +
      '}\n'
  );
  cg = CodeGraph.initSync(tmpDir);
  await cg.indexAll();
});

afterAll(() => {
  cg?.close();
  if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
});

const q = (params: Record<string, string>) => new URLSearchParams(params);

describe('classification helpers', () => {
  it('crossing: JS → native is a bridge, native → JS an event, anything else nothing', () => {
    expect(crossing('tsx', 'swift')).toBe('bridge');
    expect(crossing('swift', 'tsx')).toBe('event');
    expect(crossing('typescript', 'javascript')).toBeNull();
    expect(crossing('swift', 'objc')).toBeNull();
  });
  it('store files', () => {
    expect(isStoreFile('src/storage/capture.storage.ts')).toBe(true);
    expect(isStoreFile('src/stores/user.ts')).toBe(true);
    expect(isStoreFile('src/features/cart/cart.slice.ts')).toBe(true);
    expect(isStoreFile('src/components/button.tsx')).toBe(false);
    expect(isStoreFile('src/restore/thing.ts')).toBe(false);
  });
  it('effects: a curated table, by reference text', () => {
    expect(effectCategory('client.post')).toBe('network');
    expect(effectCategory('fetch')).toBe('network');
    expect(effectCategory('AsyncStorage.setItem')).toBe('storage');
    expect(effectCategory('Linking.openURL')).toBe('device');
    expect(effectCategory('DdRum.addAction')).toBe('telemetry');
    expect(effectCategory('Math.max')).toBeNull();
    expect(effectCategory('i18n.t')).toBeNull();
  });
});

describe('buildSteps', () => {
  it('walks a screen through its handler, the bridge, the event, the store and the request', async () => {
    const review = cg.getNodesByKind('route').find((r) => r.name === '/capture/review')!;
    expect(review).toBeDefined();
    const payload = await buildSteps(cg, tmpDir, q({ anchor: review.id }));

    const byLabel = new Map(payload.steps.map((s) => [s.label, s]));
    const kinds = Object.fromEntries(payload.steps.map((s) => [s.label, s.kind]));
    expect(kinds['/capture/review']).toBe('screen');
    expect(payload.steps.find((s) => s.anchor)?.label).toBe('/capture/review');
    // The handler is wired to the tap, so it is a trigger; the call it makes
    // crosses into Swift, so that is a bridge; the Swift side's event lands
    // on the named listener; the listener writes the store, leaves the index
    // through `client.post`, and navigates home behind `unlimited`.
    expect(kinds['handleApprove']).toBe('trigger');
    expect(kinds['finalizeCaptureSession']).toBe('bridge');
    expect(kinds['handleZipComplete']).toBe('event');
    expect(byLabel.get('handleZipComplete')?.event).toBe('onZipComplete');
    expect(byLabel.get('handleZipComplete')?.events).toEqual(['onZipComplete']);
    expect(kinds['setZipUri']).toBe('store');
    // One box per (function, category): both calls the upload makes into the
    // network, labelled by the first and counting the rest.
    const network = payload.steps.find((s) => s.kind === 'effect' && s.effect?.category === 'network')!;
    expect(network.label).toBe('client.post +1');
    expect(network.effect?.apis).toEqual(['client.post', 'client.get']);
    expect(network.effect?.by.name).toBe('uploadARCapture');
    expect(kinds['/']).toBe('screen');
    // Another screen is a boundary: drawn, marked, not entered.
    expect(byLabel.get('/')?.cut).toBe('screen');

    const link = (from: string, to: string) =>
      payload.links.find((l) => l.from === byLabel.get(from)!.id && l.to === byLabel.get(to)!.id);
    const req = link('handleZipComplete', 'client.post +1');
    expect(link('/capture/review', 'handleApprove')?.kind).toBe('handler');
    expect(link('handleApprove', 'finalizeCaptureSession')?.kind).toBe('bridge');
    const evt = link('finalizeCaptureSession', 'handleZipComplete');
    expect(evt?.kind).toBe('event');
    expect(evt?.synthesized).toBe(true);
    expect(evt?.via.map((v) => v.name)).toEqual(['emitZipComplete']);
    expect(evt?.when).toBe('result');
    expect(evt?.label).toContain('event onZipComplete');
    const storeLink = link('handleZipComplete', 'setZipUri');
    expect(storeLink?.kind).toBe('store');
    // Every call-shaped site says what it passes.
    expect(storeLink?.sites[0]?.args).toBe('data.uri');
    expect(link('handleApprove', 'finalizeCaptureSession')?.sites[0]?.args).toBe('');
    // One call behind an effect box: the box says it. Several: the panel does.
    const alert = payload.steps.find((s) => s.kind === 'effect' && s.effect?.category === 'device')!;
    expect(alert.label).toBe("Alert.alert('Uploaded', data.uri, […])");
    expect(network.label).toBe('client.post +1');
    expect(req?.sites.map((s) => `${s.text}(${s.args})`)).toEqual(["client.post('/frames', { uri })", "client.get('/frames/status')"]);
    expect(req?.kind).toBe('effect');
    expect(req?.via.map((v) => v.name)).toEqual(['uploadARCapture']);
    const nav = link('handleZipComplete', '/');
    expect(nav?.kind).toBe('navigates');
    expect(nav?.when).toBe('unlimited');
    expect(nav?.sites[0]?.text).toBe('replace /');
    // Every site carries the whole condition it runs under — one scenario each.
    expect(nav?.sites[0]?.when).toBe('unlimited');
    expect(evt?.sites[0]?.when).toBe('result');
    expect(storeLink?.sites[0]?.when).toBe('');

    // Rows: the anchor on 0, then one more step away each. The listener is
    // registered BY the screen (`addListener('onZipComplete', handleZipComplete)`),
    // so it sits one step from the anchor as a handler and the native event
    // arrives at it from further down — a link back up the picture — and
    // names the event on the box.
    expect(byLabel.get('/capture/review')?.depth).toBe(0);
    expect(byLabel.get('handleApprove')?.depth).toBe(1);
    expect(byLabel.get('finalizeCaptureSession')?.depth).toBe(2);
    expect(byLabel.get('handleZipComplete')?.depth).toBe(1);
    expect(link('/capture/review', 'handleZipComplete')?.kind).toBe('handler');
    expect(network.depth).toBe(2);
    expect(payload.through).toBe(false);
    expect(payload.truncated).toEqual({ steps: 0, hubs: 0, chrome: 0 });
    // No cap fired; the only thing not entered is the other screen.
    expect(payload.steps.filter((s) => s.cut !== null).map((s) => [s.label, s.cut])).toEqual([['/', 'screen']]);
  });

  it('walks through a memo-wrapped component into the screen body', async () => {
    const capture = cg.getNodesByKind('route').find((r) => r.name === '/capture')!;
    const payload = await buildSteps(cg, tmpDir, q({ anchor: capture.id }));
    const kinds = Object.fromEntries(payload.steps.map((s) => [s.label, s.kind]));
    // The wrapper and the component are render hops, folded into the link;
    // the handler is the first box, the native call the next.
    expect(kinds['handleOpen']).toBe('trigger');
    expect(kinds['finalizeCaptureSession']).toBe('bridge');
    const toHandler = payload.links.find((l) => l.to === payload.steps.find((s) => s.label === 'handleOpen')!.id)!;
    expect(toHandler.via.map((v) => v.name)).toEqual(['MemoizedCaptureComponent', 'CaptureComponent']);
    expect(payload.steps.map((s) => s.label)).not.toContain('CaptureComponent');
  });

  it('enters other screens when asked to continue through them', async () => {
    const review = cg.getNodesByKind('route').find((r) => r.name === '/capture/review')!;
    const payload = await buildSteps(cg, tmpDir, q({ anchor: review.id, through: '1' }));
    expect(payload.through).toBe(true);
    expect(payload.steps.find((s) => s.label === '/')?.cut).toBeNull();
  });

  it('anchors by name, prefers the screen, and lists the rest as ambiguous', async () => {
    const payload = await buildSteps(cg, tmpDir, q({ symbol: 'handleApprove' }));
    expect(payload.anchor.name).toBe('handleApprove');
    expect(payload.steps[0]?.kind).toBe('anchor');
    expect(payload.steps.map((s) => s.label)).toContain('finalizeCaptureSession');
  });

  it('a depth cap is announced on the step it stopped at', async () => {
    const review = cg.getNodesByKind('route').find((r) => r.name === '/capture/review')!;
    const payload = await buildSteps(cg, tmpDir, q({ anchor: review.id, depth: '2' }));
    // The bridge is two steps out: drawn, not explored — and says so.
    const bridge = payload.steps.find((s) => s.label === 'finalizeCaptureSession')!;
    expect(bridge.cut).toBe('depth');
    expect(payload.links.some((l) => l.kind === 'event')).toBe(false);
    // The listener still sits one step out, so the event step keeps its
    // handler kind: nothing arrived at it from native within the cap.
    expect(payload.steps.find((s) => s.label === 'handleZipComplete')?.kind).toBe('trigger');
  });

  it('refuses a missing anchor and an unknown id', async () => {
    await expect(buildSteps(cg, tmpDir, q({}))).rejects.toThrow(/anchor/);
    await expect(buildSteps(cg, tmpDir, q({ anchor: 'function:nope' }))).rejects.toThrow(/No symbol/);
    await expect(buildSteps(cg, tmpDir, q({ symbol: 'nothingNamedThis' }))).rejects.toThrow(/Nothing/);
  });
});
