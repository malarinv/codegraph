/**
 * Reasoning-offload configuration: the persistent, machine-level settings the
 * `codegraph offload` CLI writes, merged with `CODEGRAPH_OFFLOAD_*` env overrides.
 *
 * Stored in `~/.codegraph/config.json` under the `offload` key — the same global
 * home CodeGraph already uses for the daemon registry — because the reasoning
 * endpoint is a per-machine choice (the model you bring), not per-project state.
 * Every codegraph MCP server on the machine picks it up, so a user configures it
 * once. Env vars override the file (CI / ephemeral / advanced use).
 *
 * The API key is NEVER written to disk. The CLI stores the NAME of an env var
 * that holds it (`keyEnv`); at call time the key is read from that env var (or
 * directly from `CODEGRAPH_OFFLOAD_KEY`). So the config file carries no secret.
 */
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

export interface OffloadConfig {
  /** OpenAI-compatible base URL ending in `/v1` (e.g. https://api.cerebras.ai/v1). */
  url?: string;
  /** Model id to request (default `gpt-oss-120b`). */
  model?: string;
  /** Name of the env var holding the provider API key (the key itself is never persisted). */
  keyEnv?: string;
  /** reasoning_effort: low | medium | high (default `low`). */
  effort?: string;
  /** Output style: plain | report (default `plain`). */
  style?: string;
}

export interface ResolvedOffload {
  /** True when a reasoning endpoint is configured (by env or by file). */
  enabled: boolean;
  url?: string;
  model: string;
  /** Resolved API key (from `CODEGRAPH_OFFLOAD_KEY` or the configured `keyEnv`), if any. */
  apiKey?: string;
  /** Which env var the key came from (for `status` display) — never the key itself. */
  keySource?: string;
  effort: string;
  style: string;
  timeoutMs: number;
  maxTokens: number;
  strip: boolean;
  debug: boolean;
  /** Where the endpoint came from — drives `codegraph offload status`. */
  origin: 'env' | 'config' | 'none';
}

function configDir(): string {
  return path.join(os.homedir(), '.codegraph');
}
function configPath(): string {
  return path.join(configDir(), 'config.json');
}

function readUserConfig(): Record<string, unknown> {
  try {
    return JSON.parse(fs.readFileSync(configPath(), 'utf8')) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function writeUserConfig(cfg: Record<string, unknown>): void {
  fs.mkdirSync(configDir(), { recursive: true });
  fs.writeFileSync(configPath(), JSON.stringify(cfg, null, 2) + '\n');
}

/** The persisted offload block (empty object if none). */
export function readOffloadConfig(): OffloadConfig {
  const cfg = readUserConfig();
  const o = cfg.offload;
  return o && typeof o === 'object' ? (o as OffloadConfig) : {};
}

/** Persist (or, with `null`, clear) the offload block, leaving other config keys intact. */
export function writeOffloadConfig(offload: OffloadConfig | null): void {
  const cfg = readUserConfig();
  if (offload === null) delete cfg.offload;
  else cfg.offload = offload;
  writeUserConfig(cfg);
}

const trimmed = (v: string | undefined): string | undefined => {
  const t = v?.trim();
  return t ? t : undefined;
};

/** Merge the persisted config with `CODEGRAPH_OFFLOAD_*` env overrides (env wins). */
export function resolveOffload(env: NodeJS.ProcessEnv = process.env): ResolvedOffload {
  const c = readOffloadConfig();
  const url = trimmed(env.CODEGRAPH_OFFLOAD_URL) ?? trimmed(c.url);

  // Key: direct env var first, else the configured env-var name. Never from disk.
  let apiKey: string | undefined;
  let keySource: string | undefined;
  if (trimmed(env.CODEGRAPH_OFFLOAD_KEY)) {
    apiKey = trimmed(env.CODEGRAPH_OFFLOAD_KEY);
    keySource = 'CODEGRAPH_OFFLOAD_KEY';
  } else if (c.keyEnv && trimmed(env[c.keyEnv])) {
    apiKey = trimmed(env[c.keyEnv]);
    keySource = c.keyEnv;
  }

  const origin: ResolvedOffload['origin'] = trimmed(env.CODEGRAPH_OFFLOAD_URL)
    ? 'env'
    : trimmed(c.url)
      ? 'config'
      : 'none';

  return {
    enabled: !!url,
    url,
    model: trimmed(env.CODEGRAPH_OFFLOAD_MODEL) ?? trimmed(c.model) ?? 'gpt-oss-120b',
    apiKey,
    keySource,
    effort: trimmed(env.CODEGRAPH_OFFLOAD_EFFORT) ?? trimmed(c.effort) ?? 'low',
    style: trimmed(env.CODEGRAPH_OFFLOAD_STYLE) ?? trimmed(c.style) ?? 'plain',
    timeoutMs: Number(env.CODEGRAPH_OFFLOAD_TIMEOUT_MS) || 20000,
    maxTokens: Number(env.CODEGRAPH_OFFLOAD_MAXTOKENS) || 12000,
    strip: env.CODEGRAPH_OFFLOAD_STRIP === '1',
    debug: env.CODEGRAPH_OFFLOAD_DEBUG === '1',
    origin,
  };
}
