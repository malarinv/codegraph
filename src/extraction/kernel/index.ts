/**
 * Kernel routing — which languages go through the native kernel, and the
 * single entry point the extraction path calls.
 *
 * Routing policy is deliberately TS-side and per-language (migration plan §2):
 * a language routes to the kernel only after its equivalence gate passes;
 * everything else stays on the wasm path forever if need be. Rollback per
 * language = removing it from DEFAULT_ROUTED (or CODEGRAPH_KERNEL=0 for all).
 *
 * R1 status: NO language is default-routed yet. Development/testing opt-in:
 *   CODEGRAPH_KERNEL_LANGS=typescript,tsx   (or "all" for every kernel-capable
 *   language). R3 flips TS/JS into DEFAULT_ROUTED once the gate passes.
 */

import type { ExtractionResult, Language } from '../../types';
import { getKernel, kernelSupports } from './loader';
import { decodeExtractBuffers } from './decode';

export { getKernel, kernelSupports, resetKernelForTests } from './loader';
export { decodeExtractBuffers } from './decode';

/**
 * Languages routed to the kernel by default (gate-passed only — see the
 * per-language tracker in docs/design/rust-kernel-migration-plan.md §4).
 */
const DEFAULT_ROUTED: ReadonlySet<Language> = new Set<Language>([]);

/**
 * Per-language TS post-pass over the decoded result — the escape hatch for
 * logic `.scm` queries can't express (macro salvage, dialect sniffing,
 * wrapper-based component recognition). Runs synchronously after decode,
 * before the framework extract() hooks the caller applies. Keep these SMALL:
 * anything heavy belongs in the Rust emitter.
 */
export type KernelPostPass = (result: ExtractionResult, source: string) => void;
const POST_PASSES: Partial<Record<Language, KernelPostPass>> = {
  // (none yet — R2+)
};

function isRouted(language: Language): boolean {
  const env = process.env.CODEGRAPH_KERNEL_LANGS;
  if (env === undefined || env === '') return DEFAULT_ROUTED.has(language);
  if (env === 'all') return true;
  return env
    .split(',')
    .map((s) => s.trim())
    .includes(language);
}

/** True when `language` would be extracted by the kernel right now. */
export function kernelRoutes(language: Language): boolean {
  return isRouted(language) && kernelSupports(language);
}

/** Warned-once registry so a broken language logs a single line, not one per file. */
const warned = new Set<string>();

/**
 * Extract via the native kernel. Returns null when the kernel doesn't apply
 * (not routed / not available / kill switch) — the caller falls back to the
 * wasm TreeSitterExtractor. A kernel ERROR on a routed file also returns
 * null: per-file fallback keeps indexing correct while a kernel bug costs
 * only that file's speedup.
 */
export function tryKernelExtract(
  filePath: string,
  source: string,
  language: Language
): ExtractionResult | null {
  if (!kernelRoutes(language)) return null;
  const kernel = getKernel();
  if (!kernel) return null;
  const t0 = Date.now();
  try {
    // NOTE(T2 languages): when a preParse-carrying language (csharp #237,
    // metal #1121, cuda #1172, c/cpp macro blanking) routes here, its
    // offset-preserving preParse hook must be applied to `source` first —
    // wire that alongside the language's port, gated WITH its equivalence run.
    const buffers = kernel.extractFile(filePath, source, language);
    const result = decodeExtractBuffers(buffers, filePath, language);
    POST_PASSES[language]?.(result, source);
    result.durationMs = Date.now() - t0;
    return result;
  } catch (err) {
    if (!warned.has(language)) {
      warned.add(language);
      process.stderr.write(
        `[codegraph-kernel] ${language} extraction failed (${
          err instanceof Error ? err.message : String(err)
        }) — falling back to the wasm path\n`
      );
    }
    return null;
  }
}
