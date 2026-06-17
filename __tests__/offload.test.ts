/**
 * Reasoning offload — config resolution, persistence, and strict degradation.
 *
 * The offload sends explore's assembled source to a BYO OpenAI-compatible
 * reasoning endpoint and returns the synthesized answer. Two invariants are
 * load-bearing and covered here:
 *   1. The API key is NEVER written to disk — the config stores only the NAME of
 *      an env var (`keyEnv`); the key is resolved at call time.
 *   2. The path is STRICTLY DEGRADABLE — any failure (no endpoint, network error,
 *      non-2xx, empty body) returns null so the caller serves local source; it
 *      never throws and never surfaces an error to the agent.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import {
  readOffloadConfig,
  writeOffloadConfig,
  resolveOffload,
} from '../src/reasoning/config';
import { isOffloadEnabled, synthesizeOffload, stripAgentDirectives } from '../src/reasoning/reasoner';

describe('reasoning offload', () => {
  let home: string;

  // Point ~/.codegraph at a throwaway dir (os.homedir() honors $HOME on POSIX,
  // $USERPROFILE on Windows) + start from a clean env each test.
  const HOME_ENV = ['HOME', 'USERPROFILE'];
  const OFFLOAD_ENV = [
    'CODEGRAPH_OFFLOAD_URL', 'CODEGRAPH_OFFLOAD_MODEL', 'CODEGRAPH_OFFLOAD_KEY',
    'CODEGRAPH_OFFLOAD_EFFORT', 'CODEGRAPH_OFFLOAD_STYLE', 'CODEGRAPH_OFFLOAD_TIMEOUT_MS',
    'CODEGRAPH_OFFLOAD_MAXTOKENS', 'CODEGRAPH_OFFLOAD_STRIP', 'CODEGRAPH_OFFLOAD_DEBUG',
    'CEREBRAS_API_KEY',
  ];
  let saved: Record<string, string | undefined>;

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-offload-'));
    saved = {};
    for (const k of [...HOME_ENV, ...OFFLOAD_ENV]) { saved[k] = process.env[k]; delete process.env[k]; }
    process.env.HOME = home;
    process.env.USERPROFILE = home;
  });

  afterEach(() => {
    for (const k of [...HOME_ENV, ...OFFLOAD_ENV]) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    vi.restoreAllMocks();
    if (fs.existsSync(home)) fs.rmSync(home, { recursive: true, force: true });
  });

  describe('config persistence', () => {
    it('is off, with sensible defaults, when nothing is configured', () => {
      const c = resolveOffload();
      expect(c.enabled).toBe(false);
      expect(c.origin).toBe('none');
      expect(c.model).toBe('gpt-oss-120b');
      expect(c.effort).toBe('low');
      expect(c.style).toBe('plain');
      expect(isOffloadEnabled()).toBe(false);
    });

    it('round-trips the config block and never writes the API key to disk', () => {
      writeOffloadConfig({ url: 'https://api.cerebras.ai/v1', model: 'gpt-oss-120b', keyEnv: 'CEREBRAS_API_KEY' });
      expect(readOffloadConfig().url).toBe('https://api.cerebras.ai/v1');

      const raw = fs.readFileSync(path.join(home, '.codegraph', 'config.json'), 'utf8');
      expect(raw).toContain('CEREBRAS_API_KEY'); // the env var NAME is stored
      // ...but no actual secret material. Set a key and confirm it isn't on disk.
      process.env.CEREBRAS_API_KEY = 'sk-super-secret-value';
      expect(fs.readFileSync(path.join(home, '.codegraph', 'config.json'), 'utf8'))
        .not.toContain('sk-super-secret-value');
    });

    it('resolves the API key from the configured env var at call time', () => {
      writeOffloadConfig({ url: 'https://api.cerebras.ai/v1', keyEnv: 'CEREBRAS_API_KEY' });
      expect(resolveOffload().apiKey).toBeUndefined(); // env var not set yet
      process.env.CEREBRAS_API_KEY = 'sk-live';
      const c = resolveOffload();
      expect(c.enabled).toBe(true);
      expect(c.apiKey).toBe('sk-live');
      expect(c.keySource).toBe('CEREBRAS_API_KEY');
      expect(c.origin).toBe('config');
    });

    it('clears the offload block on disable, leaving other config keys intact', () => {
      const cfgPath = path.join(home, '.codegraph', 'config.json');
      fs.mkdirSync(path.dirname(cfgPath), { recursive: true });
      fs.writeFileSync(cfgPath, JSON.stringify({ somethingElse: 1, offload: { url: 'x' } }));
      writeOffloadConfig(null);
      const after = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
      expect(after.offload).toBeUndefined();
      expect(after.somethingElse).toBe(1);
    });
  });

  describe('env overrides config', () => {
    it('lets CODEGRAPH_OFFLOAD_URL override the file and report origin=env', () => {
      writeOffloadConfig({ url: 'https://file.example/v1' });
      process.env.CODEGRAPH_OFFLOAD_URL = 'https://env.example/v1';
      const c = resolveOffload();
      expect(c.url).toBe('https://env.example/v1');
      expect(c.origin).toBe('env');
    });

    it('reads the key directly from CODEGRAPH_OFFLOAD_KEY when set', () => {
      process.env.CODEGRAPH_OFFLOAD_URL = 'https://env.example/v1';
      process.env.CODEGRAPH_OFFLOAD_KEY = 'sk-direct';
      const c = resolveOffload();
      expect(c.apiKey).toBe('sk-direct');
      expect(c.keySource).toBe('CODEGRAPH_OFFLOAD_KEY');
    });
  });

  describe('strict degradation (never throws, returns null to fall back)', () => {
    it('returns null when no endpoint is configured', async () => {
      expect(await synthesizeOffload({ query: 'q', context: 'ctx' })).toBeNull();
    });

    it('returns null when the upstream request rejects', async () => {
      writeOffloadConfig({ url: 'https://api.cerebras.ai/v1' });
      vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('ECONNREFUSED')));
      expect(await synthesizeOffload({ query: 'q', context: 'ctx' })).toBeNull();
    });

    it('returns null on a non-2xx response', async () => {
      writeOffloadConfig({ url: 'https://api.cerebras.ai/v1' });
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
        ok: false, status: 500, text: async () => 'boom',
      }));
      expect(await synthesizeOffload({ query: 'q', context: 'ctx' })).toBeNull();
    });

    it('returns null when the model returns an empty answer', async () => {
      writeOffloadConfig({ url: 'https://api.cerebras.ai/v1' });
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
        ok: true, status: 200, json: async () => ({ choices: [{ message: { content: '   ' } }] }),
      }));
      expect(await synthesizeOffload({ query: 'q', context: 'ctx' })).toBeNull();
    });
  });

  describe('success path', () => {
    it('returns the synthesized answer (with the plain footer) and posts an OpenAI-compatible body with the key', async () => {
      writeOffloadConfig({ url: 'https://api.cerebras.ai/v1', model: 'gpt-oss-120b', keyEnv: 'CEREBRAS_API_KEY' });
      process.env.CEREBRAS_API_KEY = 'sk-live';
      const fetchMock = vi.fn().mockResolvedValue({
        ok: true, status: 200,
        json: async () => ({ choices: [{ message: { content: 'Coverage: full.\nThe answer.' }, finish_reason: 'stop' }] }),
      });
      vi.stubGlobal('fetch', fetchMock);

      const out = await synthesizeOffload({ query: 'how does X work', context: 'source here' });
      expect(out).toContain('Coverage: full.');
      expect(out).toContain('Synthesized by CodeGraph'); // plain footer present

      const [calledUrl, init] = fetchMock.mock.calls[0];
      expect(calledUrl).toBe('https://api.cerebras.ai/v1/chat/completions');
      expect((init.headers as Record<string, string>).authorization).toBe('Bearer sk-live');
      const body = JSON.parse(init.body as string);
      expect(body.model).toBe('gpt-oss-120b');
      expect(body.messages[1].content).toContain('source here');
      expect(body.messages[1].content).toContain('how does X work');
    });
  });

  describe('stripAgentDirectives', () => {
    it('drops the agent-directed header but keeps source sections', () => {
      const ctx = [
        '## Exploration: how does X work',
        'Found 12 symbols across 3 files.',
        '',
        '#### src/a.ts — foo(function)',
        'code body',
      ].join('\n');
      const stripped = stripAgentDirectives(ctx);
      expect(stripped).not.toContain('## Exploration:');
      expect(stripped).not.toContain('Found 12 symbols');
      expect(stripped).toContain('#### src/a.ts');
      expect(stripped).toContain('code body');
    });
  });
});
