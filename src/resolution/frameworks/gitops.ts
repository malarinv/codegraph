/**
 * GitOps Framework Resolver.
 *
 * Kubernetes manifests, FluxCD objects, Crossplane claims and Backstage catalog
 * entities are all YAML documents that declare what other documents depend on
 * them:
 *
 *   apiVersion: kustomize.toolkit.fluxcd.io/v1
 *   kind: Kustomization
 *   metadata:
 *     name: crossplane-app-dns-dev
 *   spec:
 *     path: ./dns/dev
 *     sourceRef:
 *       kind: GitRepository
 *       name: flux-system
 *     dependsOn:
 *       - name: crossplane-providers
 *         namespace: crossplane-vcluster
 *
 * YAML is otherwise a file-level-only language here (grammars.ts
 * `isFileLevelOnlyLanguage`), so none of these documents reach a generic
 * extractor. This resolver is the opt-in path instead, gated to repos that
 * actually hold GitOps manifests — a repo whose only YAML is `mkdocs.yml` or
 * `.gitlab-ci.yml` emits nothing at all.
 *
 * ## What it emits
 *
 * - One `struct` node per document that declares `apiVersion` + `kind`, named
 *   `<kind>/<metadata.name>`. The id embeds the file path and start line, so
 *   two documents sharing a kind/name in different files stay distinct nodes.
 * - `references` edges for the keys that point at another document — see
 *   `REFERENCE_KEYS`. Everything else in a manifest is local data.
 * - One `constant` node per *data* YAML file — a flat file with no
 *   `apiVersion`/`kind` whose basename is a valid identifier. Rego policies
 *   read those as `data.<basename>`; a node of that name is what turns
 *   "what breaks when this policy's data changes" into a graph question.
 *
 * ## Design decisions
 *
 * - No new NodeKind/EdgeKind/Language members: documents reuse `struct`, data
 *   files reuse `constant`, edges reuse `references`. Every member existed
 *   because some extractor needed it; adding one for YAML is not worth the
 *   schema surface.
 * - `resolve()` never synthesizes a node. Nodes come only from `extract()`, so
 *   an indexed-but-not-yet-extracted file can't produce a phantom target.
 * - Reference emission is an allowlist, not a walk. A generic walk would emit
 *   edges from every string that happens to look like a name, which is the
 *   noise that makes a graph useless.
 */

import path from 'node:path';
import { parseAllDocuments } from 'yaml';
import type { Document } from 'yaml';

import { Node } from '../../types';
import { FrameworkResolver, ResolutionContext, ResolvedRef, UnresolvedRef } from '../types';

// ---------------------------------------------------------------------------
// Document detection
// ---------------------------------------------------------------------------

/** Values that make a parsed YAML document a Kubernetes-style manifest. */
interface Manifest {
  apiVersion: string;
  kind: string;
  metadataName?: string;
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/**
 * A document counts as a manifest only when it declares both `apiVersion` and
 * `kind` as strings at top level. Helm values files, generic config and
 * `mkdocs.yml` have neither and produce nothing.
 */
function readManifest(doc: unknown): Manifest | null {
  if (typeof doc !== 'object' || doc === null || Array.isArray(doc)) return null;
  const record = doc as Record<string, unknown>;
  const apiVersion = asString(record['apiVersion']);
  const kind = asString(record['kind']);
  if (!apiVersion || !kind) return null;
  const metadata = record['metadata'];
  const metadataName =
    typeof metadata === 'object' && metadata !== null && !Array.isArray(metadata)
      ? asString((metadata as Record<string, unknown>)['name'])
      : null;
  return { apiVersion, kind, metadataName: metadataName ?? undefined };
}

/** A `spec` mapping, when the document has one. */
function readSpec(doc: unknown): Record<string, unknown> | null {
  if (typeof doc !== 'object' || doc === null || Array.isArray(doc)) return null;
  const spec = (doc as Record<string, unknown>)['spec'];
  if (typeof spec !== 'object' || spec === null || Array.isArray(spec)) return null;
  return spec as Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Reference keys
// ---------------------------------------------------------------------------

/**
 * The keys whose value points at another document. Each entry maps a YAML key
 * to how its value names that document:
 *
 * - `ref`  — an object with `kind` + `name` (`sourceRef`, `providerConfigRef`).
 * - `refs` — an array of such objects (`dependsOn`).
 * - `names` — an array of file names pointing at sibling manifests — a
 *            kustomize `Kustomization`'s own `resources:` list, which sits at
 *            the document root rather than under `spec`.
 * - `name` — a bare `name` string (`secretRef`).
 * - `path` — a directory path relative to the referencing file (Kustomization).
 *
 * A Flux `Receiver`'s `resources[]` holds `kind`+`name` objects and reads as
 * the same `names` key, so the two are told apart by the entry's shape.
 *
 * `values` on a HelmRelease is deliberately absent: values are configuration,
 * not pointers, and an edge from a release to its own values file is noise.
 */
const REFERENCE_KEYS: ReadonlyArray<{ key: string; shape: 'ref' | 'refs' | 'names' | 'name' | 'path' }> = [
  { key: 'sourceRef', shape: 'ref' },
  { key: 'dependsOn', shape: 'refs' },
  { key: 'resources', shape: 'names' },
  { key: 'providerConfigRef', shape: 'ref' },
  { key: 'secretRef', shape: 'name' },
  { key: 'path', shape: 'path' },
];

/**
 * `<kind>/<name>` for a pointer object. Flux omits `kind` on `dependsOn`
 * entries because these deps are always other Kustomizations, so a name-only
 * entry takes that default rather than being dropped.
 *
 * Returns null for a real YAML-file path or anything without a usable name:
 * those are not document pointers.
 */
function namedRef(value: unknown): string | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const name = asString(record['name']);
  if (!name) return null;
  const kind = asString(record['kind']) ?? 'Kustomization';
  return `${kind}/${name}`;
}

/**
 * Collect the reference names a manifest's `spec` points at. Deliberately
 * narrow: only the keys in `REFERENCE_KEYS` produce anything.
 */
function collectReferenceNames(spec: Record<string, unknown> | null): string[] {
  if (!spec) return [];
  const names: string[] = [];
  for (const { key, shape } of REFERENCE_KEYS) {
    if (!(key in spec)) continue;
    const value = spec[key];
    switch (shape) {
      case 'ref': {
        const named = namedRef(value);
        if (named) names.push(named);
        break;
      }
      case 'refs': {
        if (Array.isArray(value)) {
          for (const entry of value) {
            const named = namedRef(entry);
            if (named) names.push(named);
          }
        }
        break;
      }
      case 'names': {
        if (!Array.isArray(value)) break;
        for (const entry of value) {
          // A Flux Receiver's `resources[]` holds kind+name objects; a
          // kustomize Kustomization's holds sibling file names.
          if (typeof entry === 'object' && entry !== null) {
            const named = namedRef(entry);
            if (named) names.push(named);
          } else {
            const target = asString(entry);
            if (target) names.push(target);
          }
        }
        break;
      }
      case 'name': {
        const named = asString(value);
        if (named) names.push(named);
        break;
      }
      case 'path': {
        const target = asString(value);
        if (target) names.push(target);
        break;
      }
    }
  }
  return names;
}

// ---------------------------------------------------------------------------
// Data YAML
// ---------------------------------------------------------------------------

/**
 * A data file is named for what Rego reads: `data.<name>`. A name is only a
 * data-file name when it carries a word separator (`_`) or a digit —
 * `kustomization.yaml` and `mkdocs.yml` are ordinary config files whose names
 * must never be matched by a `data.<x>` lookup, while `consensus_bounds` and
 * `policy_limits2` are exactly what Rego reads.
 */
const IDENTIFIER = /^[a-z][a-z0-9]*(?:_[a-z0-9]+|[0-9][a-z0-9_]*)$/;

// ---------------------------------------------------------------------------
// Resolver
// ---------------------------------------------------------------------------

export const gitopsResolver: FrameworkResolver = {
  name: 'gitops',
  // `extract()` runs only on `.yml`/`.yaml` files.
  languages: ['yaml'],
  // Rego policies read data files as `data.<basename>`; those references are
  // written in Rego, so `resolve()` must see them. Widening via
  // `resolveLanguages` (not `languages`) keeps `extract()` off Rego files.
  resolveLanguages: ['rego', 'yaml'],

  // The reference pre-filter drops any name no symbol in the index carries.
  // Rego's `data.<file>.<field>` path is never a symbol name, and neither is a
  // sibling manifest file name or directory a Kustomization lists in
  // `resources`, so the reference would be discarded before this resolver's
  // `resolve()` ever ran. Claim those shapes so they reach `resolve()`, which
  // then names the node the reference leads to.
  claimsReference(name: string): boolean {
    return (
      /^(?:data|input)\./.test(name) ||
      /\.(?:yaml|yml)$/.test(name) ||
      BARE_DIRECTORY.test(name)
    );
  },

  detect(context: ResolutionContext): boolean {
    if (context.fileExists?.('cluster') || context.fileExists?.('clusters')) return true;
    if (context.fileExists?.('kustomization.yaml') || context.fileExists?.('Kustomization')) {
      return true;
    }

    const files = context.getAllFiles();
    if (files.some((file) => file.startsWith('clusters/') || file.startsWith('cluster/'))) return true;

    // Last resort: scan a bounded prefix for anyone's manifest. This catches
    // repos that keep manifests somewhere other than `clusters/`.
    const limit = Math.min(files.length, 200);
    for (let i = 0; i < limit; i++) {
      const file = files[i]!;
      if (!file.endsWith('.yml') && !file.endsWith('.yaml')) continue;
      const content = context.readFile(file);
      if (!content) continue;
      if (isGitOpsManifest(content)) return true;
    }
    return false;
  },

  extract(filePath: string, content: string): { nodes: Node[]; references: UnresolvedRef[] } {
    // Malformed YAML is not this resolver's problem to report; a file that
    // fails to parse yields nothing.
    const documents = tryParseAllDocuments(content);
    if (documents.length === 0) return { nodes: [], references: [] };
    const now = Date.now();

    let sawManifest = false;
    const nodes: Node[] = [];
    const references: UnresolvedRef[] = [];

    for (const parsed of documents) {
      // A document the lexer/parser rejected is not a manifest or a data
      // file, however much of it `toJS()` can still reconstruct.
      if (parsed.errors.length > 0) continue;
      const value: unknown = parsed.toJS();
      if (value === undefined || value === null) continue;

      const manifest = readManifest(value);
      if (!manifest) continue;
      sawManifest = true;

      const name = manifest.metadataName
        ? `${manifest.kind}/${manifest.metadataName}`
        : `${manifest.kind}/${path.basename(filePath).replace(/\.(yaml|yml)$/, '')}`;
      const line = parsed.range ? lineFromIndex(content, parsed.range[0]) : 1;
      const endLine = parsed.range
        ? lineFromIndex(content, parsed.range[2] ?? content.length)
        : line;
      const id = `struct:${filePath}:${line}`;

      nodes.push({
        id,
        kind: 'struct',
        name,
        qualifiedName: `${filePath}::${name}`,
        filePath,
        // `signature` is the only field a Node has for a short summary; there
        // is no `extra` map to hang the manifest's identity on.
        signature: `${manifest.apiVersion} ${manifest.kind}`,
        startLine: line,
        endLine,
        startColumn: 0,
        endColumn: 0,
        language: 'yaml',
        updatedAt: now,
      });

      const specLine = lineOfKey(content, 'spec', line);
      const rootLine = lineOfKey(content, 'resources', line);
      // Per document: a name referenced by two documents is two edges.
      const emitted = new Set<string>();
      // Both levels can name the same pointer — a manifest that puts
      // `dependsOn` under `spec` and again at the root — so one reference per
      // named target, keyed by name. Each level carries its own line.
      const emit = (names: string[], at: number) => {
        for (const referenceName of names) {
          if (emitted.has(referenceName)) continue;
          emitted.add(referenceName);
          references.push({
            fromNodeId: id,
            referenceName,
            referenceKind: 'references',
            line: at,
            column: 0,
            filePath,
            language: 'yaml',
          });
        }
      };
      emit(collectReferenceNames(readSpec(value)), specLine);
      emit(collectReferenceNames(value as Record<string, unknown>), rootLine);
    }

    if (sawManifest) return { nodes, references };

    // No manifest: this is a data YAML file. Emit one `constant` node so Rego's
    // `data.<basename>` reference has a target — but only when the basename is
    // a valid identifier, so `kustomization.yaml` and `mkdocs.yml` can never
    // be matched by accident.
    const dataName = path.basename(filePath).replace(/\.(yaml|yml)$/, '');
    if (!IDENTIFIER.test(dataName)) return { nodes: [], references: [] };

    const lineCount = content === '' ? 1 : content.split('\n').length;
    const id = `constant:${filePath}:1`;
    nodes.push({
      id,
      kind: 'constant',
      name: dataName,
      qualifiedName: `${filePath}::${dataName}`,
      filePath,
      startLine: 1,
      endLine: lineCount,
      startColumn: 0,
      endColumn: 0,
      language: 'yaml',
      updatedAt: now,
    });

    return { nodes, references };
  },

  resolve(ref: UnresolvedRef, context: ResolutionContext): ResolvedRef | null {
    // Document pointers: a Kustomization's `spec.path` and `resources:`
    // entries — a sibling file name, or a directory named `./dir`, `../dir`,
    // or bare (kustomize accepts all three).
    if (
      ref.referenceName.startsWith('./') ||
      ref.referenceName.startsWith('../') ||
      /\.(?:yaml|yml)$/.test(ref.referenceName) ||
      // A bare directory name has no dot, and must hold a kustomization.
      (!ref.referenceName.includes('.') &&
        BARE_DIRECTORY.test(ref.referenceName) &&
        hasKustomizationAt(ref.filePath, ref.referenceName, context))
    ) {
      const target = resolvePathRef(ref.filePath, ref.referenceName, context);
      return target ? { original: ref, targetNodeId: target, confidence: 0.9, resolvedBy: 'file-path' } : null;
    }

    // A YAML → YAML reference names a document node (`GitRepository/flux-system`).
    // Those are resolved by ordinary name matching, not here.
    if (ref.referenceName.includes('/')) return null;

    // Rego reads data files as `data.<file>.<field>`, and a bare
    // `data.<file>` when it reads the document itself. The extractor keeps the
    // whole path as the reference name, so the file is the LAST segment for a
    // bare reference and the one before it once a field follows.
    let dataName = ref.referenceName;
    if (dataName.includes('.')) {
      const segments = dataName.split('.');
      if (segments.length < 2) return null;
      dataName = segments.length === 2 ? segments[1]! : segments[segments.length - 2]!;
    }

    // Find it by name, and require it to be one of this resolver's `constant`
    // data nodes so an identically named code symbol can't be bound to a policy.
    const matches = context.getNodesByName(dataName).filter(
      (node) => node.kind === 'constant' && node.language === 'yaml'
    );
    // Ambiguity (same basename in two `policy/data` dirs) is left unresolved —
    // a wrong edge outranks a missing one.
    if (matches.length !== 1) return null;
    return { original: ref, targetNodeId: matches[0]!.id, confidence: 0.95, resolvedBy: 'exact-match' };
  },
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Well-formed YAML documents, or [] when the source fails to parse. */
function tryParseAllDocuments(content: string): Document.Parsed[] {
  try {
    return parseAllDocuments(content);
  } catch {
    return [];
  }
}

/**
 * True when the content declares a manifest: an `apiVersion` and a `kind`.
 *
 * Detection used to require a Flux or Crossplane group, but the documents this
 * resolver indexes are not only theirs — a Backstage `catalog-info.yaml`, a
 * Crossplane claim, and every Kustomize object carry the same pair. Requiring
 * a named group left a Backstage-only repository like `security-pipeline` with
 * no manifest detected, so its Rego data files were never linked to the
 * policies that read them. Any manifest now counts: the `resources:`
 * and pointer keys this resolver reads are the same in each of them.
 */
function isGitOpsManifest(content: string): boolean {
  for (const parsed of tryParseAllDocuments(content)) {
    const manifest = readManifest(parsed.toJS());
    if (manifest) return true;
  }
  return false;
}

/** 1-indexed line of a byte offset. */
function lineFromIndex(content: string, index: number): number {
  return content.slice(0, Math.max(0, index)).split('\n').length;
}

/** A name kustomize writes for a directory of manifests (`consensus`, `my-app`). */
const BARE_DIRECTORY = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

/**
 * Whether a bare directory name beside `filePath` holds a kustomization. This
 * is what tells a `resources: [- consensus]` entry from any other bare name:
 * the directory must actually declare one, which stops a data-file name like
 * `consensus_bounds` from being read as a directory.
 */
function hasKustomizationAt(
  filePath: string,
  referenceName: string,
  context: ResolutionContext
): boolean {
  const target = path.posix.normalize(path.posix.join(path.posix.dirname(filePath), referenceName));
  return (
    (context.fileExists?.(`${target}/kustomization.yaml`) ?? false) ||
    (context.fileExists?.(`${target}/Kustomization`) ?? false)
  );
}

/** 1-indexed line of the first top-level `key:` at or after `from`. */
function lineOfKey(content: string, key: string, from: number): number {
  const wanted = new RegExp(`^${key}:`, 'm');
  const lines = content.split('\n');
  for (let i = from - 1; i < lines.length; i++) {
    if (wanted.test(lines[i]!)) return i + 1;
  }
  return from;
}

/**
 * Resolve a document pointer to the node it identifies: a sibling manifest
 * file name (`resources: [gitrepository.yaml]`) or a directory path
 * (`spec.path: ./dns/dev`) naming the Kustomization or documents in it,
 * relative to the referencing file's own directory. Returns null when no node
 * exists — a pointer to something this project has no manifest for is no edge.
 */
function resolvePathRef(
  filePath: string,
  referenceName: string,
  context: ResolutionContext
): string | null {
  const dir = path.posix.dirname(filePath);
  const isFile = /\.(?:yaml|yml)$/.test(referenceName);
  const target = path.posix.normalize(path.posix.join(dir, referenceName));

  if (isFile) {
    const inFile = context.getNodesInFile(target);
    return inFile.length > 0 ? inFile[0]!.id : null;
  }

  const kustomization = `${target}/kustomization.yaml`;
  if (context.fileExists?.(kustomization) || context.fileExists?.(`${target}/Kustomization`)) {
    // The manifest names the directory, not the document: a kustomize file
    // without `metadata.name` is indexed as `Kustomization/kustomization`, so
    // finding the node by the file it lives in is the one lookup that always
    // holds.
    const inFile = context.getNodesInFile(kustomization);
    if (inFile.length === 1) return inFile[0]!.id;
    if (inFile.length > 1) {
      const byKind = inFile.filter((node) => node.kind === 'struct');
      if (byKind.length === 1) return byKind[0]!.id;
      return inFile[0]!.id;
    }
    return null;
  }

  const yamlFile = `${target}.yaml`;
  if (context.fileExists?.(yamlFile)) {
    const inFile = context.getNodesInFile(yamlFile);
    return inFile.length > 0 ? inFile[0]!.id : null;
  }

  return null;
}
