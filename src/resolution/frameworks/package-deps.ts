/**
 * The dependencies a project declares — in its root `package.json` and in
 * the ones one or two directories down (`apps/web/package.json`,
 * `frontend/package.json`, `packages/api/package.json`). A framework detector
 * that reads only the root misses every monorepo: proshop keeps `react` in
 * `frontend/`, a Turborepo keeps `next` in `apps/web/`, and the resolver for
 * that framework then never runs, so its routes never exist.
 */

import type { ResolutionContext } from '../types';

/** Nested manifests read per project, at most — a monorepo with hundreds of packages is sampled, not scanned. */
const MAX_MANIFESTS = 24;

const cache = new WeakMap<ResolutionContext, Set<string>>();

/** Every dependency name declared at the root or up to two directories down, de-duplicated. */
export function declaredDependencies(context: ResolutionContext): Set<string> {
  const cached = cache.get(context);
  if (cached) return cached;
  const names = new Set<string>();
  const manifests = ['package.json'];
  for (const file of context.getAllFiles()) {
    if (manifests.length > MAX_MANIFESTS) break;
    if (/^(?:[^/]+\/){1,2}package\.json$/.test(file) && !file.includes('node_modules/')) manifests.push(file);
  }
  for (const manifest of manifests) {
    const content = context.readFile(manifest);
    if (!content) continue;
    try {
      const pkg = JSON.parse(content) as { dependencies?: Record<string, string>; devDependencies?: Record<string, string>; peerDependencies?: Record<string, string> };
      for (const group of [pkg.dependencies, pkg.devDependencies, pkg.peerDependencies]) {
        if (group && typeof group === 'object') for (const name of Object.keys(group)) names.add(name);
      }
    } catch {
      // Not JSON — a template, a broken manifest; nothing to read.
    }
  }
  cache.set(context, names);
  return names;
}

/** True when any of `deps` is declared anywhere the project's manifests are read. */
export function dependsOn(context: ResolutionContext, ...deps: string[]): boolean {
  const names = declaredDependencies(context);
  return deps.some((d) => names.has(d));
}
