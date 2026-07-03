import type { Node as SyntaxNode } from 'web-tree-sitter';
import { getNodeText } from '../tree-sitter-helpers';
import type { LanguageExtractor } from '../tree-sitter-types';

// Grammar: tree-sitter-terraform (vendored at src/extraction/wasm/tree-sitter-terraform.wasm,
// built from @tree-sitter-grammars/tree-sitter-hcl, Apache-2.0). The HCL grammar
// is intentionally generic: ALL Terraform top-level constructs share the same
// AST node type `block`, distinguished only by the first `identifier` child
// (the block "type": resource, variable, data, module, output, locals, …).
// Labels for resources/data/modules/variables come from `string_lit` children
// AFTER that first identifier.
//
//   resource "aws_s3_bucket" "my_bucket" { ... }
//   └─ block
//        ├─ identifier            ("resource")
//        ├─ string_lit            ("aws_s3_bucket")  ← type label
//        ├─ string_lit            ("my_bucket")      ← name label
//        ├─ block_start
//        ├─ body
//        │    ├─ attribute (identifier "bucket" "=" expression)
//        │    └─ block ("tags" { ... })                ← nested block (skipped)
//        └─ block_end
//
// References live inside `expression` subtrees: a leading `identifier` followed
// by zero or more `get_attr` (`.foo`) nodes. We synthesise qualified-name refs
// matching the node names emitted above (e.g. `var.region` → unresolved ref
// `var.region`, which the matcher resolves to the `variable "region"` node).

/** Built-in references that should NOT be resolved to project nodes. */
const BUILTIN_HEADS = new Set([
  'each',         // for_each iterator: each.key / each.value
  'count',        // count meta-argument: count.index
  'self',         // provisioner connection self.*
  'path',         // path.module / path.root / path.cwd
  'terraform',    // terraform.workspace
]);

/** Bare strings that we never want to treat as references. */
const BUILTIN_KEYWORDS = new Set(['null', 'true', 'false']);

/** Read a string_lit value (skipping the quotes / template start/end tokens). */
function stringLitValue(node: SyntaxNode, source: string): string {
  const literal = node.namedChildren.find((c) => c?.type === 'template_literal');
  if (literal) return getNodeText(literal, source);
  // Empty string ("") parses as quoted_template_start + quoted_template_end
  // with no template_literal — return empty.
  return '';
}

/** Block "type" and its label values. Returns null if the block is malformed. */
function readBlockHeader(block: SyntaxNode, source: string): { type: string; labels: string[] } | null {
  const named = block.namedChildren.filter((c): c is SyntaxNode => c !== null);
  const first = named[0];
  if (!first || first.type !== 'identifier') return null;
  const type = getNodeText(first, source);
  const labels: string[] = [];
  for (let i = 1; i < named.length; i++) {
    const child = named[i];
    if (!child) continue;
    if (child.type === 'string_lit') {
      labels.push(stringLitValue(child, source));
    } else if (child.type === 'identifier') {
      // HCL allows unquoted identifier labels (rare in Terraform but legal).
      labels.push(getNodeText(child, source));
    } else {
      break;
    }
  }
  return { type, labels };
}

/** Find the `body` child of a block (it's after the labels and block_start). */
function getBlockBody(block: SyntaxNode): SyntaxNode | null {
  return block.namedChildren.find((c) => c?.type === 'body') ?? null;
}

/**
 * Walk an `expression` subtree and emit a reference for every dotted name
 * whose head is a Terraform reference root (var / local / module / data / a
 * resource type name). Skips built-ins.
 *
 * Patterns we recognise:
 *   var.X        → ref "var.X"           (variable "X")
 *   local.X      → ref "local.X"         (locals.X)
 *   module.M.O   → ref "module.M"        (module "M")
 *   data.T.N.A   → ref "data.T.N"        (data "T" "N")
 *   T.N[.A]      → ref "T.N"             (resource "T" "N", e.g. aws_x.y)
 */
function collectReferences(
  expr: SyntaxNode,
  source: string,
  onRef: (qualifiedName: string, line: number, column: number) => void
): void {
  // BFS for variable_expr and inspect each. variable_expr's only child is an
  // identifier (the head); its siblings via get_attr / index chains live on
  // the parent _expr_term, so walk the parent chain to collect them.
  const queue: SyntaxNode[] = [expr];
  while (queue.length) {
    const n = queue.shift()!;
    if (n.type === 'variable_expr') {
      emitRefFromVariableExpr(n, source, onRef);
      // Don't recurse into the chain we just read — but DO continue scanning
      // siblings (e.g. function call arguments).
    }
    for (const c of n.namedChildren) {
      if (c) queue.push(c);
    }
  }
}

function emitRefFromVariableExpr(
  varExpr: SyntaxNode,
  source: string,
  onRef: (qualifiedName: string, line: number, column: number) => void
): void {
  const id = varExpr.namedChildren.find((c) => c?.type === 'identifier');
  if (!id) return;
  const head = getNodeText(id, source);
  if (BUILTIN_HEADS.has(head) || BUILTIN_KEYWORDS.has(head)) return;

  // Walk get_attr siblings on the parent. The AST shape is roughly:
  //   expression > _expr_term (hidden) → variable_expr + get_attr + get_attr + ...
  // tree-sitter exposes _expr_term children flattened on `expression`.
  const attrs: string[] = [];
  let cursor: SyntaxNode | null = varExpr.nextNamedSibling;
  while (cursor) {
    if (cursor.type === 'get_attr') {
      const attrId = cursor.namedChildren.find((c) => c?.type === 'identifier');
      if (!attrId) break;
      attrs.push(getNodeText(attrId, source));
      cursor = cursor.nextNamedSibling;
    } else if (cursor.type === 'index' || cursor.type === 'new_index' || cursor.type === 'legacy_index' || cursor.type === 'splat' || cursor.type === 'attr_splat' || cursor.type === 'full_splat') {
      // foo[0], foo[*], foo.*  — keep walking but don't add a segment.
      cursor = cursor.nextNamedSibling;
    } else {
      break;
    }
  }

  const line = varExpr.startPosition.row + 1;
  const col = varExpr.startPosition.column;
  for (const qname of qualifyReference(head, attrs)) onRef(qname, line, col);
}

function qualifyReference(head: string, attrs: string[]): string[] {
  switch (head) {
    case 'var':
      // var.X — variable "X"
      return attrs[0] ? [`var.${attrs[0]}`] : [];
    case 'local':
      // local.K — locals attribute K
      return attrs[0] ? [`local.${attrs[0]}`] : [];
    case 'module':
      // module.M[.OUTPUT] — module "M". A two-segment chain (`module.M.out`)
      // additionally emits a scoped `module.M:output.out` ref that the
      // Terraform resolver bridges to the `output "out"` node inside the
      // module's source directory — the edge that carries impact across the
      // module boundary instead of dead-ending at the declaration. Only the
      // Terraform framework resolver understands the `:`-scoped spelling; if
      // the module's source is a registry/git address the ref simply stays
      // unresolved and the boundary remains visible.
      if (!attrs[0]) return [];
      return attrs[1]
        ? [`module.${attrs[0]}`, `module.${attrs[0]}:output.${attrs[1]}`]
        : [`module.${attrs[0]}`];
    case 'data':
      // data.TYPE.NAME[.ATTR] — data "TYPE" "NAME"
      return attrs[0] && attrs[1] ? [`data.${attrs[0]}.${attrs[1]}`] : [];
    default:
      // <type>.<name>[.<attr>...] — managed resource (e.g. aws_s3_bucket.my)
      // Skip plain identifiers with no dotted chain — those are function calls,
      // local-only variables, or template params.
      if (!attrs[0]) return [];
      return [`${head}.${attrs[0]}`];
  }
}

export const terraformExtractor: LanguageExtractor = {
  // The HCL grammar exposes everything as `block` / `attribute`; the default
  // dispatcher does not know how to read Terraform's first-identifier-as-type
  // convention, so we drive extraction entirely from visitNode below.
  functionTypes: [],
  classTypes: [],
  methodTypes: [],
  interfaceTypes: [],
  structTypes: [],
  enumTypes: [],
  typeAliasTypes: [],
  importTypes: [],
  callTypes: [],
  variableTypes: [],
  nameField: '',
  bodyField: '',
  paramsField: '',

  visitNode: (node, ctx) => {
    if (node.type !== 'block') {
      // .tfvars files carry no blocks — just top-level `name = value`
      // assignments, each of which SETS the root module variable of that
      // name. Reference the variable from the file node so "what sets
      // var.region" is answerable from the graph.
      if (
        node.type === 'attribute' &&
        ctx.filePath.endsWith('.tfvars') &&
        node.parent?.type === 'body' &&
        node.parent.parent?.type === 'config_file'
      ) {
        const idNode = node.namedChildren.find((c) => c?.type === 'identifier');
        const fileNodeId = ctx.nodeStack[0];
        if (idNode && fileNodeId) {
          ctx.addUnresolvedReference({
            fromNodeId: fileNodeId,
            referenceName: `var.${getNodeText(idNode, ctx.source)}`,
            referenceKind: 'references',
            line: node.startPosition.row + 1,
            column: node.startPosition.column,
          });
        }
        return true;
      }
      // Let the default walker descend into bodies/expressions; we only claim
      // top-level blocks.
      return false;
    }

    const header = readBlockHeader(node, ctx.source);
    if (!header) return false;
    const { type, labels } = header;
    const body = getBlockBody(node);

    // --- locals: every attribute becomes its own constant ---
    if (type === 'locals' && labels.length === 0) {
      emitLocals(body, ctx);
      return true; // we handled everything inside this block
    }

    // --- terraform { ... } settings block — no symbols, no refs to project ---
    if (type === 'terraform' && labels.length === 0) {
      return true;
    }

    // --- resource / data / module / variable / output / provider ---
    const decl = describeBlock(type, labels);
    if (!decl) {
      // Unknown top-level block (e.g. nested block hoisted as top-level via
      // walker). Let the default walker continue.
      return false;
    }

    const created = ctx.createNode(decl.kind, decl.name, node, {
      qualifiedName: decl.qualifiedName,
      signature: decl.signature,
      isExported: decl.kind === 'variable',
    });

    if (!created) return true;

    // Collect references inside this block's body (attribute expressions).
    if (body) {
      ctx.pushScope(created.id);
      try {
        emitReferencesInBody(body, ctx, created.id);
        if (type === 'module' && labels[0]) {
          emitModuleWiring(labels[0], node, body, ctx, created.id);
        }
      } finally {
        ctx.popScope();
      }
    }
    return true;
  },
};

/**
 * Module meta-arguments — attributes of a `module` block that configure the
 * call itself rather than set one of the child module's input variables.
 */
const MODULE_META_ARGS = new Set(['source', 'version', 'count', 'for_each', 'providers', 'depends_on']);

/**
 * Bridge a `module "M" { ... }` block across the module boundary with
 * `:`-scoped references that only the Terraform framework resolver
 * understands (a plain qualified name would let the generic matcher bind
 * them to a same-named symbol in an unrelated module — a wrong edge is
 * worse than none):
 *
 *   - `module.M:file`      (imports)    → the module source directory's
 *     entry file, when `source` is a local `./`/`../` path. Registry and
 *     git sources emit nothing — an out-of-repo module stays a visible
 *     boundary instead of a guessed edge.
 *   - `module.M:var.<in>`  (references) → the child module's
 *     `variable "<in>"` node, one per input attribute. This is what lets
 *     "what depends on modules/vpc's var.cidr" reach the callers.
 */
function emitModuleWiring(
  moduleName: string,
  block: SyntaxNode,
  body: SyntaxNode,
  ctx: Parameters<NonNullable<LanguageExtractor['visitNode']>>[1],
  fromNodeId: string
): void {
  for (const attr of body.namedChildren) {
    if (!attr || attr.type !== 'attribute') continue;
    const idNode = attr.namedChildren.find((c) => c?.type === 'identifier');
    if (!idNode) continue;
    const attrName = getNodeText(idNode, ctx.source);
    if (attrName === 'source') {
      const expr = attr.namedChildren.find((c) => c?.type === 'expression');
      const lit = expr ? findStringLit(expr) : null;
      const source = lit ? stringLitValue(lit, ctx.source) : '';
      if (source.startsWith('./') || source.startsWith('../')) {
        ctx.addUnresolvedReference({
          fromNodeId,
          referenceName: `module.${moduleName}:file`,
          referenceKind: 'imports',
          line: block.startPosition.row + 1,
          column: block.startPosition.column,
        });
      }
      continue;
    }
    if (MODULE_META_ARGS.has(attrName)) continue;
    ctx.addUnresolvedReference({
      fromNodeId,
      referenceName: `module.${moduleName}:var.${attrName}`,
      referenceKind: 'references',
      line: attr.startPosition.row + 1,
      column: attr.startPosition.column,
    });
  }
}

/** First string_lit anywhere under an expression (source = "./modules/x"). */
function findStringLit(expr: SyntaxNode): SyntaxNode | null {
  const queue: SyntaxNode[] = [expr];
  while (queue.length) {
    const n = queue.shift()!;
    if (n.type === 'string_lit') return n;
    for (const c of n.namedChildren) {
      if (c) queue.push(c);
    }
  }
  return null;
}

interface BlockDecl {
  kind: 'class' | 'module' | 'variable' | 'namespace';
  name: string;
  qualifiedName: string;
  signature: string;
}

function describeBlock(type: string, labels: string[]): BlockDecl | null {
  const [first, second] = labels;
  switch (type) {
    case 'resource': {
      if (!first || !second) return null;
      return {
        kind: 'class',
        name: `${first}.${second}`,
        qualifiedName: `${first}.${second}`,
        signature: `resource "${first}" "${second}"`,
      };
    }
    case 'data': {
      if (!first || !second) return null;
      return {
        kind: 'class',
        name: `${first}.${second}`,
        qualifiedName: `data.${first}.${second}`,
        signature: `data "${first}" "${second}"`,
      };
    }
    case 'module': {
      if (!first) return null;
      return {
        kind: 'module',
        name: first,
        qualifiedName: `module.${first}`,
        signature: `module "${first}"`,
      };
    }
    case 'variable': {
      if (!first) return null;
      return {
        kind: 'variable',
        name: first,
        qualifiedName: `var.${first}`,
        signature: `variable "${first}"`,
      };
    }
    case 'output': {
      if (!first) return null;
      return {
        kind: 'variable',
        name: first,
        qualifiedName: `output.${first}`,
        signature: `output "${first}"`,
      };
    }
    case 'provider': {
      if (!first) return null;
      return {
        kind: 'namespace',
        name: first,
        qualifiedName: `provider.${first}`,
        signature: `provider "${first}"`,
      };
    }
    default:
      return null;
  }
}

function emitLocals(
  body: SyntaxNode | null,
  ctx: Parameters<NonNullable<LanguageExtractor['visitNode']>>[1]
): void {
  if (!body) return;
  for (const attr of body.namedChildren) {
    if (!attr || attr.type !== 'attribute') continue;
    const idNode = attr.namedChildren.find((c) => c?.type === 'identifier');
    if (!idNode) continue;
    const name = getNodeText(idNode, ctx.source);
    const created = ctx.createNode('constant', name, attr, {
      qualifiedName: `local.${name}`,
      signature: `local.${name}`,
    });
    if (!created) continue;
    const expr = attr.namedChildren.find((c) => c?.type === 'expression');
    if (expr) {
      ctx.pushScope(created.id);
      try {
        collectReferences(expr, ctx.source, (qname, line, column) => {
          ctx.addUnresolvedReference({
            fromNodeId: created.id,
            referenceName: qname,
            referenceKind: 'references',
            line,
            column,
          });
        });
      } finally {
        ctx.popScope();
      }
    }
  }
}

function emitReferencesInBody(
  body: SyntaxNode,
  ctx: Parameters<NonNullable<LanguageExtractor['visitNode']>>[1],
  fromNodeId: string
): void {
  const queue: SyntaxNode[] = [body];
  while (queue.length) {
    const n = queue.shift()!;
    if (n.type === 'expression') {
      collectReferences(n, ctx.source, (qname, line, column) => {
        ctx.addUnresolvedReference({
          fromNodeId,
          referenceName: qname,
          referenceKind: 'references',
          line,
          column,
        });
      });
      // Don't descend into expression — collectReferences already does.
      continue;
    }
    for (const c of n.namedChildren) {
      if (c) queue.push(c);
    }
  }
}
