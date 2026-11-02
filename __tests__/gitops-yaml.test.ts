/**
 * GitOps YAML: manifests become nodes, pointer-shaped keys become references,
 * and Rego's `data.<name>` resolves to a data-file node.
 *
 * Validated on snowbud's `clusters/` (Flux Kustomization + HelmRelease +
 * Crossplane claims) and whiteblossom-apps (Flux + Crossplane DNS records).
 */
import { describe, it, expect } from 'vitest';
import { gitopsResolver } from '../src/resolution/frameworks/gitops';

const DNS_RECORD = `apiVersion: dns.cloudflare.upbound.io/v1alpha1
kind: Record
metadata:
  name: www-dev-a-record
  namespace: crossplane-system
spec:
  forProvider:
    name: dev.whiteblossom.net
    type: A
`;

const KUSTOMIZATION = `apiVersion: kustomize.toolkit.fluxcd.io/v1
kind: Kustomization
metadata:
  name: crossplane-app-dns-dev
  namespace: flux-system
spec:
  path: ./dns/dev
  sourceRef:
    kind: GitRepository
    name: flux-system
  dependsOn:
    - name: crossplane-providers
      namespace: crossplane-vcluster
  interval: 30m
`;

const MULTI_DOC = `apiVersion: v1
kind: Namespace
metadata:
  name: crossplane-system
---
apiVersion: v1
kind: ConfigMap
metadata:
  name: app-config
data:
  key: value
`;

describe('gitops manifest extraction', () => {
  it('emits one node per apiVersion+kind document, and no edges for local data', () => {
    const { nodes, references } = gitopsResolver.extract!('dns/record.yaml', DNS_RECORD);

    expect(nodes).toHaveLength(1);
    expect(nodes[0]!.name).toBe('Record/www-dev-a-record');
    expect(nodes[0]!.kind).toBe('struct');
    expect(nodes[0]!.language).toBe('yaml');
    expect(nodes[0]!.signature).toBe('dns.cloudflare.upbound.io/v1alpha1 Record');
    // `forProvider` is local data — it must not become an edge.
    expect(references).toEqual([]);
  });

  it('emits references only for pointer-shaped keys', () => {
    const { nodes, references } = gitopsResolver.extract!('dns/kustomization.yaml', KUSTOMIZATION);

    expect(nodes.map((n) => n.name)).toEqual(['Kustomization/crossplane-app-dns-dev']);
    // `dependsOn` carries no `kind` — Flux defaults it to another Kustomization —
    // so the entry names `Kustomization/crossplane-providers`, namespace aside.
    expect(references.map((r) => r.referenceName).sort()).toEqual([
      './dns/dev',
      'GitRepository/flux-system',
      'Kustomization/crossplane-providers',
    ]);
    // Every edge leaves the document node and is a plain reference.
    expect(references.every((r) => r.fromNodeId === nodes[0]!.id)).toBe(true);
    expect(references.every((r) => r.referenceKind === 'references')).toBe(true);
  });

  it('distinguishes documents sharing kind/name across files, and numbers multi-doc files', () => {
    const first = gitopsResolver.extract!('a/record.yaml', DNS_RECORD);
    const second = gitopsResolver.extract!('b/record.yaml', DNS_RECORD);
    expect(first.nodes[0]!.id).not.toBe(second.nodes[0]!.id);
    expect(first.nodes[0]!.name).toBe(second.nodes[0]!.name);

    const multi = gitopsResolver.extract!('ns.yaml', MULTI_DOC);
    expect(multi.nodes.map((n) => n.name)).toEqual(['Namespace/crossplane-system', 'ConfigMap/app-config']);
    expect(multi.nodes[1]!.startLine).toBeGreaterThan(multi.nodes[0]!.startLine);
    // `data:` inside a ConfigMap is a payload, not a Rego-style data pointer.
    expect(multi.references).toEqual([]);
  });
});

describe('gitops data-file extraction', () => {
  it('emits one constant node for an identifier-named data file', () => {
    const { nodes, references } = gitopsResolver.extract!('policy/data/consensus_bounds.yaml', 'minQuorum: 2\n');

    expect(nodes).toHaveLength(1);
    expect(nodes[0]!.name).toBe('consensus_bounds');
    expect(nodes[0]!.kind).toBe('constant');
    expect(nodes[0]!.language).toBe('yaml');
    expect(references).toEqual([]);
  });

  it('emits nothing for a non-identifier basename, so Rego cannot match by accident', () => {
    expect(gitopsResolver.extract!('kustomization.yaml', 'resources: []\n').nodes).toEqual([]);
    expect(gitopsResolver.extract!('mkdocs.yml', 'site_name: Docs\ntheme: material\n').nodes).toEqual([]);
    expect(gitopsResolver.extract!('.gitlab-ci.yml', 'build:\n  script: npm run build\n').nodes).toEqual([]);
  });

  it('survives malformed YAML', () => {
    expect(gitopsResolver.extract!('broken.yaml', 'apiVersion: v1\nkind: [unclosed\n').nodes).toEqual([]);
    expect(gitopsResolver.extract!('empty.yaml', '').nodes).toEqual([]);
  });
});

describe('gitops claimsReference', () => {
  // The reference pre-filter drops any name no symbol in the index carries.
  // A Rego `data.<file>.<field>` path and a sibling manifest file name are
  // never symbol names, so without this claim they are discarded before
  // `resolve()` ever runs.
  it("claims a data/input path and a sibling manifest name", () => {
    expect(gitopsResolver.claimsReference!('data.consensus_bounds.min_quorum')).toBe(true);
    expect(gitopsResolver.claimsReference!('input.metadata.name')).toBe(true);
    expect(gitopsResolver.claimsReference!('gitrepository.yaml')).toBe(true);
    expect(gitopsResolver.claimsReference!('GitRepository/flux-system')).toBe(false);
    // A bare name is claimed too: a `resources: [- consensus]` directory looks
    // like any other name. `resolve()` then only answers when a kustomization
    // really sits beside the referencing file, so the broad claim costs nothing.
    expect(gitopsResolver.claimsReference!('threshold')).toBe(true);
  });
});

describe('kustomize Kustomization', () => {
  const KUSTOMIZE = `apiVersion: kustomize.config.k8s.io/v1beta1
kind: Kustomization
resources:
  - gitrepository.yaml
  - helmrelease.yaml
`;

  it("reads resources from the document root, not spec", () => {
    const { nodes, references } = gitopsResolver.extract!('dev/consensus/kustomization.yaml', KUSTOMIZE);

    expect(nodes.map((n) => n.name)).toEqual(['Kustomization/kustomization']);
    expect(references.map((r) => r.referenceName).sort()).toEqual(['gitrepository.yaml', 'helmrelease.yaml']);
  });

  it("resolves a resources[] entry to that file's document node", () => {
    const context = {
      getNodesInFile: (file: string) =>
        file === 'dev/consensus/gitrepository.yaml'
          ? [{ id: 'struct:dev/consensus/gitrepository.yaml:1', name: 'GitRepository/consensus' }]
          : [],
      getNodesByName: () => [],
      getNodesByKind: () => [],
      getNodesByQualifiedName: () => [],
      getNodesByLowerName: () => [],
      fileExists: () => false,
      readFile: () => null,
      getProjectRoot: () => '',
      getAllFiles: () => [],
    };

    const resolved = gitopsResolver.resolve!(
      {
        fromNodeId: 'struct:dev/consensus/kustomization.yaml:1',
        referenceName: 'gitrepository.yaml',
        referenceKind: 'references',
        line: 4,
        column: 0,
        filePath: 'dev/consensus/kustomization.yaml',
        language: 'yaml',
      },
      context
    );
    expect(resolved!.targetNodeId).toBe('struct:dev/consensus/gitrepository.yaml:1');
    expect(resolved!.resolvedBy).toBe('file-path');
  });
});

describe('gitops detection', () => {
  const context = (files: string[] = [], exists: string[] = []) => ({
    getNodesInFile: () => [],
    getNodesByName: () => [],
    getNodesByKind: () => [],
    getNodesByQualifiedName: () => [],
    getNodesByLowerName: () => [],
    fileExists: (path: string) => exists.includes(path),
    readFile: () => null,
    getProjectRoot: () => '',
    getAllFiles: () => files,
  });

  it('detects on clusters/ even with no flux apiVersion yet', () => {
    expect(gitopsResolver.detect(context(['clusters/dev/app.yaml'], []))).toBe(true);
    expect(gitopsResolver.detect(context([], ['kustomization.yaml']))).toBe(true);
    expect(gitopsResolver.detect(context([], ['Kustomization']))).toBe(true);
  });

  it('detects a repo whose manifests are not Flux or Crossplane', () => {
    // security-pipeline is a Rego policy repo whose only manifest is a
    // Backstage catalog-info.yaml. Detection used to require a Flux or
    // Crossplane group, which left its `data.<file>` references unlinked to
    // the data files their policies read.
    const catalog = {
      ...context(['catalog-info.yaml', 'mkdocs.yml', 'policy/data/consensus_bounds.yaml'], []),
      readFile: (path: string) =>
        path === 'catalog-info.yaml'
          ? 'apiVersion: backstage.io/v1alpha1\nkind: Component\nmetadata:\n  name: security-pipeline\n'
          : 'name: security-pipeline\n',
    };
    expect(gitopsResolver.detect(catalog)).toBe(true);
  });

  it('does not detect a repo whose only YAML is generic config', () => {
    expect(gitopsResolver.detect(context(['mkdocs.yml', 'docs/index.md'], []))).toBe(false);
  });
});

describe('gitops reference resolution', () => {
  const node = (name: string, id: string) => ({ id, name, kind: 'constant', language: 'yaml' });
  const context = (nodes: ReturnType<typeof node>[], exists: string[] = []) => ({
    getNodesInFile: () => [],
    getNodesByName: (name: string) => nodes.filter((n) => n.name === name),
    getNodesByKind: () => [],
    getNodesByQualifiedName: () => [],
    getNodesByLowerName: () => [],
    fileExists: (path: string) => exists.includes(path),
    readFile: () => null,
    getProjectRoot: () => '',
    getAllFiles: () => [],
  });

  const ref = (referenceName: string, filePath = 'clusters/dev/kustomization.yaml') => ({
    fromNodeId: 'struct:clusters/dev/kustomization.yaml:1',
    referenceName,
    referenceKind: 'references' as const,
    line: 1,
    column: 0,
    filePath,
    language: 'rego' as const,
  });

  it("resolves Rego's data.<name> to exactly one data node", () => {
    const resolved = gitopsResolver.resolve!(
      ref('consensus_bounds', 'policy/audit.rego'),
      context([node('consensus_bounds', 'constant:policy/data/consensus_bounds.yaml:1')])
    );
    expect(resolved).not.toBeNull();
    expect(resolved!.targetNodeId).toBe('constant:policy/data/consensus_bounds.yaml:1');
    expect(resolved!.resolvedBy).toBe('exact-match');
  });

  it('refuses an ambiguous data name and a document ref', () => {
    const ambiguous = context([
      node('consensus_bounds', 'constant:a/consensus_bounds.yaml:1'),
      node('consensus_bounds', 'constant:b/consensus_bounds.yaml:1'),
    ]);
    expect(gitopsResolver.resolve!(ref('consensus_bounds'), ambiguous)).toBeNull();
    // A document reference names a code-side symbol, not a data file.
    expect(gitopsResolver.resolve!(ref('GitRepository/flux-system'), ambiguous)).toBeNull();
    // A code symbol that merely shares the name must not be capturable.
    const codeSymbol = context([
      { id: 'fn:audit.rego:3', name: 'consensus_bounds', kind: 'function', language: 'rego' },
    ]);
    expect(gitopsResolver.resolve!(ref('consensus_bounds'), codeSymbol)).toBeNull();
  });

  it("resolves Rego's data.<file>.<field> to the data file", () => {
    // The Rego extractor keeps the whole path as the reference name; the file
    // is the segment between the `data` prefix and the field.
    const resolved = gitopsResolver.resolve!(
      ref('data.consensus_bounds.min_quorum', 'policy/audit.rego'),
      context([node('consensus_bounds', 'constant:policy/data/consensus_bounds.yaml:1')])
    );
    expect(resolved!.targetNodeId).toBe('constant:policy/data/consensus_bounds.yaml:1');
    // Reading the document itself names it directly.
    expect(
      gitopsResolver.resolve!(
        ref('data.consensus_bounds', 'policy/audit.rego'),
        context([node('consensus_bounds', 'constant:policy/data/consensus_bounds.yaml:1')])
      )!.targetNodeId
    ).toBe('constant:policy/data/consensus_bounds.yaml:1');
  });

  it("resolves spec.path to the target directory's Kustomization", () => {
    // `path` is relative to the referencing manifest's own directory, and the
    // node is found in that file — a kustomize file without `metadata.name` is
    // indexed as `Kustomization/kustomization`, not by its directory.
    const ctx = {
      getNodesInFile: (file: string) =>
        file === 'clusters/dev/dns/kustomization.yaml'
          ? [{ id: 'struct:clusters/dev/dns/kustomization.yaml:1', kind: 'struct' }]
          : [],
      getNodesByName: () => [],
      getNodesByKind: () => [],
      getNodesByQualifiedName: () => [],
      getNodesByLowerName: () => [],
      fileExists: (p: string) => p === 'clusters/dev/dns/kustomization.yaml',
      readFile: () => null,
      getProjectRoot: () => '',
      getAllFiles: () => [],
    };
    const resolved = gitopsResolver.resolve!(ref('./dns'), ctx);
    expect(resolved!.targetNodeId).toBe('struct:clusters/dev/dns/kustomization.yaml:1');
    expect(resolved!.resolvedBy).toBe('file-path');
  });

  it("resolves a bare resources[] directory name to that kustomization", () => {
    // kustomize writes `resources: [- consensus]` with no `./`; the directory
    // must actually hold a kustomization, which is what tells this from any
    // other bare name.
    const bare = (name: string, fromFile: string, exists: string[]) => {
      const ctx = {
        getNodesInFile: (file: string) =>
          file === 'dev/consensus/kustomization.yaml'
            ? [{ id: 'struct:dev/consensus/kustomization.yaml:1', kind: 'struct' }]
            : [],
        getNodesByName: () => [],
        getNodesByKind: () => [],
        getNodesByQualifiedName: () => [],
        getNodesByLowerName: () => [],
        fileExists: (p: string) => exists.includes(p),
        readFile: () => null,
        getProjectRoot: () => '',
        getAllFiles: () => [],
      };
      return gitopsResolver.resolve!(
        { ...ref(name), filePath: fromFile, language: 'yaml' as const },
        ctx
      );
    };

    const resolved = bare('consensus', 'dev/kustomization.yaml', ['dev/consensus/kustomization.yaml']);
    expect(resolved!.targetNodeId).toBe('struct:dev/consensus/kustomization.yaml:1');
    // A bare name with no kustomization beside it is not a directory pointer.
    expect(bare('consensus_bounds', 'policy/data/x.yaml', [])).toBeNull();
    expect(bare('consensus', 'dev/kustomization.yaml', [])).toBeNull();
  });

  it('leaves a path with no indexed manifest unresolved', () => {
    const resolved = gitopsResolver.resolve!(ref('./missing'), context([node('Kustomization/missing', 'x')], []));
    expect(resolved).toBeNull();
  });
});
