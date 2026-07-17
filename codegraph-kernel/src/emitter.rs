//! Generic query-driven emitter: parse the file, run the language's `.scm`
//! query, and emit flat rows. The whole tree walk happens native-side; the
//! only JS boundary crossing is the returned buffers.
//!
//! Mechanics mirrored from `TreeSitterExtractor` (src/extraction/tree-sitter.ts):
//!   - node row 0 is the file node (`file:<path>`, endLine = newline count + 1,
//!     isExported present+false — byte-parity with the TS file node);
//!   - definitions form a scope stack by byte-range nesting; qualifiedName is
//!     the stack's names joined with `::` (file excluded);
//!   - every definition gets a `contains` edge from its parent scope (the
//!     file node when top-level);
//!   - references attach to the innermost enclosing definition, falling back
//!     to the file node — same as the TS extractor's nodeStack semantics;
//!   - definitions with empty names are skipped (issue #42 semantics).

use crate::buffers::{
    build_meta, edge_kind_index, node_kind_index, Arena, BoolFlags, EdgeRow, NodeRow, RefRow,
    Tables, FLAG_IS_EXPORTED, FUNCTION_REF_CODE, NODE_KINDS, NONE, NONE_STR,
};
use crate::ids;
use crate::langs::LangSpec;
use streaming_iterator::StreamingIterator;
use tree_sitter::{Node, Parser, QueryCursor};

pub struct EmitOut {
    pub meta: Vec<u8>,
    pub nodes: Vec<u8>,
    pub edges: Vec<u8>,
    pub refs: Vec<u8>,
    pub arena: Vec<u8>,
}

/// What a query capture name means. Resolved once per query.
#[derive(Clone, Copy)]
enum Role {
    /// `@def.<NodeKind>` — value is the NODE_KINDS index.
    Def(u8),
    /// `@name` — the paired definition's name node.
    Name,
    /// `@ref.<EdgeKind>` / `@ref.function_ref` — value is the wire code.
    Ref(u8),
    /// Helper captures (`@_anchor` etc.) — ignored.
    Ignore,
}

fn resolve_roles(capture_names: &[&str], lang: &str) -> Result<Vec<Role>, String> {
    capture_names
        .iter()
        .map(|name| {
            if let Some(kind) = name.strip_prefix("def.") {
                let idx = node_kind_index(kind)
                    .ok_or_else(|| format!("{lang}: unknown NodeKind in capture @{name}"))?;
                Ok(Role::Def(idx))
            } else if let Some(kind) = name.strip_prefix("ref.") {
                if kind == "function_ref" {
                    return Ok(Role::Ref(FUNCTION_REF_CODE));
                }
                let idx = edge_kind_index(kind)
                    .ok_or_else(|| format!("{lang}: unknown EdgeKind in capture @{name}"))?;
                Ok(Role::Ref(idx))
            } else if *name == "name" {
                Ok(Role::Name)
            } else {
                Ok(Role::Ignore)
            }
        })
        .collect()
}

struct Def {
    kind: u8,
    name_start: usize,
    name_end: usize,
    start_byte: usize,
    end_byte: usize,
    start_line: u32,
    end_line: u32,
    start_column: u32,
    end_column: u32,
    /// Node-table row index, assigned during the scope sweep.
    row: u32,
}

struct RefCap {
    kind: u8,
    name_start: usize,
    name_end: usize,
    start_byte: usize,
    line: u32,
    column: u32,
}

pub fn extract(file_path: &str, source: &str, spec: &LangSpec) -> Result<EmitOut, String> {
    let t0 = std::time::Instant::now();

    let mut parser = Parser::new();
    parser
        .set_language(spec.language())
        .map_err(|e| format!("set_language({}) failed: {e}", spec.name))?;
    let tree = parser
        .parse(source, None)
        .ok_or_else(|| "parser returned null tree".to_string())?;
    let root = tree.root_node();

    let query = spec.query()?;
    let roles = resolve_roles(&query.capture_names(), spec.name)?;

    // ---- Collect definition + reference captures from the query. ----
    let mut defs: Vec<Def> = Vec::new();
    let mut refs: Vec<RefCap> = Vec::new();
    // A node can match several patterns (e.g. nested alternations); first
    // pattern wins, mirroring the TS walk's one-node-one-symbol behaviour.
    let mut seen_defs = std::collections::HashSet::<usize>::new();

    let mut cursor = QueryCursor::new();
    let mut matches = cursor.matches(query, root, source.as_bytes());
    while let Some(m) = matches.next() {
        let mut def_node: Option<(Node, u8)> = None;
        let mut name_node: Option<Node> = None;
        for cap in m.captures {
            match roles[cap.index as usize] {
                Role::Def(kind) => def_node = Some((cap.node, kind)),
                Role::Name => name_node = Some(cap.node),
                Role::Ref(kind) => {
                    let p = cap.node.start_position();
                    refs.push(RefCap {
                        kind,
                        name_start: cap.node.start_byte(),
                        name_end: cap.node.end_byte(),
                        start_byte: cap.node.start_byte(),
                        line: p.row as u32 + 1,
                        column: p.column as u32,
                    });
                }
                Role::Ignore => {}
            }
        }
        if let (Some((node, kind)), Some(name)) = (def_node, name_node) {
            // Empty names are not meaningful symbols (issue #42).
            if name.end_byte() > name.start_byte() && seen_defs.insert(node.id()) {
                let sp = node.start_position();
                let ep = node.end_position();
                defs.push(Def {
                    kind,
                    name_start: name.start_byte(),
                    name_end: name.end_byte(),
                    start_byte: node.start_byte(),
                    end_byte: node.end_byte(),
                    start_line: sp.row as u32 + 1,
                    end_line: ep.row as u32 + 1,
                    start_column: sp.column as u32,
                    end_column: ep.column as u32,
                    row: 0,
                });
            }
        }
    }

    // Deterministic pre-order regardless of query-match ordering.
    defs.sort_by(|a, b| {
        a.start_byte
            .cmp(&b.start_byte)
            .then(b.end_byte.cmp(&a.end_byte))
    });
    refs.sort_by_key(|r| r.start_byte);

    // ---- Emit rows: file node first, then the scope-stack sweep. ----
    let mut arena = Arena::default();
    let mut tables = Tables::default();

    let line_count = source.bytes().filter(|b| *b == b'\n').count() as u32 + 1;
    let base_name = file_path.rsplit(['/', '\\']).next().unwrap_or(file_path);
    let mut file_flags = BoolFlags::default();
    file_flags.set(FLAG_IS_EXPORTED, false);
    let file_id = arena.put(&ids::file_node_id(file_path));
    let file_name = arena.put(base_name);
    let file_qn = arena.put(file_path);
    tables.push_node(&NodeRow {
        kind: node_kind_index("file").unwrap(),
        visibility: 0,
        flags: file_flags,
        start_line: 1,
        end_line: line_count,
        start_column: 0,
        end_column: 0,
        name: file_name,
        qualified_name: file_qn,
        id: file_id,
        docstring: NONE_STR,
        signature: NONE_STR,
        decorators: NONE_STR,
        type_parameters: NONE_STR,
        return_type: NONE_STR,
        extra_json: NONE_STR,
    });

    // Merged sweep over definitions and references in byte order, maintaining
    // the scope stack (indices into `defs`).
    let mut stack: Vec<usize> = Vec::new();
    let mut ref_i = 0usize;

    fn pop_to(stack: &mut Vec<usize>, defs: &[Def], byte: usize) {
        while let Some(&top) = stack.last() {
            if defs[top].end_byte <= byte {
                stack.pop();
            } else {
                break;
            }
        }
    }

    let emit_ref = |r: &RefCap, stack: &[usize], defs: &[Def], arena: &mut Arena, tables: &mut Tables| {
        let from_idx = stack.last().map(|&i| defs[i].row).unwrap_or(0);
        let name = arena.put(&source[r.name_start..r.name_end]);
        tables.push_ref(&RefRow {
            from_idx,
            kind: r.kind,
            line: r.line,
            column: r.column,
            reference_name: name,
            candidates: NONE_STR,
            from_id_str: NONE_STR,
        });
    };

    for i in 0..defs.len() {
        let def_start = defs[i].start_byte;
        while ref_i < refs.len() && refs[ref_i].start_byte < def_start {
            pop_to(&mut stack, &defs, refs[ref_i].start_byte);
            emit_ref(&refs[ref_i], &stack, &defs, &mut arena, &mut tables);
            ref_i += 1;
        }
        pop_to(&mut stack, &defs, def_start);

        let name = &source[defs[i].name_start..defs[i].name_end];
        let kind_str = NODE_KINDS[defs[i].kind as usize];
        // qualifiedName = enclosing definition names + own name, `::`-joined
        // (buildQualifiedName semantics; file node excluded).
        let mut qn = String::new();
        for &s in stack.iter() {
            qn.push_str(&source[defs[s].name_start..defs[s].name_end]);
            qn.push_str("::");
        }
        qn.push_str(name);

        let id = ids::node_id(file_path, kind_str, name, defs[i].start_line);
        let id_ref = arena.put(&id);
        let name_ref = arena.put(name);
        let qn_ref = arena.put(&qn);
        let row = tables.push_node(&NodeRow {
            kind: defs[i].kind,
            visibility: 0,
            flags: BoolFlags::default(),
            start_line: defs[i].start_line,
            end_line: defs[i].end_line,
            start_column: defs[i].start_column,
            end_column: defs[i].end_column,
            name: name_ref,
            qualified_name: qn_ref,
            id: id_ref,
            docstring: NONE_STR,
            signature: NONE_STR,
            decorators: NONE_STR,
            type_parameters: NONE_STR,
            return_type: NONE_STR,
            extra_json: NONE_STR,
        });
        defs[i].row = row;

        let parent_row = stack.last().map(|&s| defs[s].row).unwrap_or(0);
        tables.push_edge(&EdgeRow {
            source_idx: parent_row,
            target_idx: row,
            kind: edge_kind_index("contains").unwrap(),
            provenance: 0,
            line: NONE,
            column: NONE,
            metadata_json: NONE_STR,
            source_id_str: NONE_STR,
            target_id_str: NONE_STR,
        });

        stack.push(i);
    }
    while ref_i < refs.len() {
        pop_to(&mut stack, &defs, refs[ref_i].start_byte);
        emit_ref(&refs[ref_i], &stack, &defs, &mut arena, &mut tables);
        ref_i += 1;
    }

    let duration_ms = t0.elapsed().as_secs_f64() * 1000.0;
    let meta = build_meta(&tables, arena.len(), NONE_STR, duration_ms);
    Ok(EmitOut {
        meta,
        nodes: tables.nodes,
        edges: tables.edges,
        refs: tables.refs,
        arena: arena.into_vec(),
    })
}
