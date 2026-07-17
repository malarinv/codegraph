//! getPrecedingDocstring / cleanCommentMarkers — faithful port of
//! src/extraction/tree-sitter-helpers.ts (#780 wrapper-climb semantics).

use regex::Regex;
use std::sync::OnceLock;
use tree_sitter::Node;

/// DOCSTRING_WRAPPER_TYPES (tree-sitter-helpers.ts).
fn is_wrapper(kind: &str) -> bool {
    matches!(
        kind,
        "export_statement"
            | "decorated_definition"
            | "lexical_declaration"
            | "variable_declaration"
            | "variable_declarator"
            | "ambient_declaration"
    )
}

fn is_comment(kind: &str) -> bool {
    matches!(
        kind,
        "comment" | "line_comment" | "block_comment" | "documentation_comment"
    )
}

struct Cleaners {
    block_open: Regex,
    block_close: Regex,
    lua_open: Regex,
    lua_close: Regex,
    paren_star_open: Regex,
    paren_star_close: Regex,
    brace_open: Regex,
    brace_close: Regex,
    slashes: Regex,
    dashes: Regex,
    hash: Regex,
    percent: Regex,
    star_cont: Regex,
}

fn cleaners() -> &'static Cleaners {
    static C: OnceLock<Cleaners> = OnceLock::new();
    C.get_or_init(|| Cleaners {
        block_open: Regex::new(r"^/\*+!?").unwrap(),
        block_close: Regex::new(r"\*+/$").unwrap(),
        lua_open: Regex::new(r"^--\[=*\[").unwrap(),
        lua_close: Regex::new(r"\]=*\]$").unwrap(),
        paren_star_open: Regex::new(r"^\(\*").unwrap(),
        paren_star_close: Regex::new(r"\*\)$").unwrap(),
        brace_open: Regex::new(r"^\{").unwrap(),
        brace_close: Regex::new(r"\}$").unwrap(),
        slashes: Regex::new(r"(?m)^//[/!]?\s?").unwrap(),
        dashes: Regex::new(r"(?m)^--\s?").unwrap(),
        hash: Regex::new(r"(?m)^#\s?").unwrap(),
        percent: Regex::new(r"(?m)^%+\s?").unwrap(),
        star_cont: Regex::new(r"(?m)^\s*\*\s?").unwrap(),
    })
}

/// cleanCommentMarkers — strip comment syntax, keep the prose.
pub fn clean_comment_markers(comment: &str) -> String {
    let c = cleaners();
    let mut s = comment.trim().to_string();
    if s.starts_with("/*") {
        s = c.block_open.replace(&s, "").into_owned();
        s = c.block_close.replace(&s, "").into_owned();
    } else if s.starts_with("--[") {
        s = c.lua_open.replace(&s, "").into_owned();
        s = c.lua_close.replace(&s, "").into_owned();
    } else if s.starts_with("(*") {
        s = c.paren_star_open.replace(&s, "").into_owned();
        s = c.paren_star_close.replace(&s, "").into_owned();
    } else if s.starts_with('{') {
        s = c.brace_open.replace(&s, "").into_owned();
        s = c.brace_close.replace(&s, "").into_owned();
    }
    s = c.slashes.replace_all(&s, "").into_owned();
    s = c.dashes.replace_all(&s, "").into_owned();
    s = c.hash.replace_all(&s, "").into_owned();
    s = c.percent.replace_all(&s, "").into_owned();
    s = c.star_cont.replace_all(&s, "").into_owned();
    s.trim().to_string()
}

/// getPrecedingDocstring — collect the comment run immediately preceding the
/// node (climbing out of declaration wrappers first), cleaned and joined.
/// Returns None when there is no preceding comment (a PRESENT-but-empty
/// docstring after cleaning still returns Some(""), matching the TS helper).
pub fn preceding_docstring(node: Node, src: &str) -> Option<String> {
    let mut anchor = node;
    while let Some(parent) = anchor.parent() {
        if is_wrapper(parent.kind()) {
            anchor = parent;
        } else {
            break;
        }
    }

    let mut comments: Vec<&str> = Vec::new();
    let mut sibling = anchor.prev_named_sibling();
    while let Some(s) = sibling {
        if is_comment(s.kind()) {
            comments.push(&src[s.byte_range()]);
            sibling = s.prev_named_sibling();
        } else {
            break;
        }
    }
    if comments.is_empty() {
        return None;
    }
    comments.reverse(); // collected nearest-first; TS unshifts to keep source order
    Some(
        comments
            .iter()
            .map(|c| clean_comment_markers(c))
            .collect::<Vec<_>>()
            .join("\n")
            .trim()
            .to_string(),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn strips_line_and_block_markers() {
        assert_eq!(clean_comment_markers("// hello"), "hello");
        assert_eq!(clean_comment_markers("/// doc line"), "doc line");
        assert_eq!(
            clean_comment_markers("/**\n * Adds things.\n * @param a first\n */"),
            "Adds things.\n@param a first"
        );
    }
}
