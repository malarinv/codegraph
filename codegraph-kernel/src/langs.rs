//! Per-language specs: grammar + `.scm` query + (later) per-language config.
//!
//! Tier-1 languages are meant to be *mostly* a query file plus a small config
//! here; logic queries can't express stays TS-side as a per-language `post()`
//! hook over the returned buffers (see `src/extraction/kernel/route.ts`).
//!
//! Language strings are codegraph `Language` values (src/types.ts), not
//! grammar names — `tsx` and `jsx` are separate entries that reuse another
//! entry's grammar exactly like `WASM_GRAMMAR_FILES` does on the wasm path.

use std::sync::OnceLock;
use tree_sitter::{Language, Query};

pub struct LangSpec {
    /// codegraph Language string (src/types.ts).
    pub name: &'static str,
    get_language: fn() -> Language,
    query_src: &'static str,
    language: OnceLock<Language>,
    query: OnceLock<Result<Query, String>>,
}

impl LangSpec {
    const fn new(name: &'static str, get_language: fn() -> Language, query_src: &'static str) -> Self {
        LangSpec {
            name,
            get_language,
            query_src,
            language: OnceLock::new(),
            query: OnceLock::new(),
        }
    }

    pub fn language(&self) -> &Language {
        self.language.get_or_init(self.get_language)
    }

    pub fn query(&self) -> Result<&Query, String> {
        self.query
            .get_or_init(|| {
                Query::new(self.language(), self.query_src)
                    .map_err(|e| format!("query compile failed for {}: {e}", self.name))
            })
            .as_ref()
            .map_err(|e| e.clone())
    }
}

fn ts_language() -> Language {
    tree_sitter_typescript::LANGUAGE_TYPESCRIPT.into()
}

fn tsx_language() -> Language {
    tree_sitter_typescript::LANGUAGE_TSX.into()
}

fn js_language() -> Language {
    tree_sitter_javascript::LANGUAGE.into()
}

static TYPESCRIPT: LangSpec = LangSpec::new(
    "typescript",
    ts_language,
    include_str!("../queries/typescript.scm"),
);
static TSX: LangSpec = LangSpec::new("tsx", tsx_language, include_str!("../queries/typescript.scm"));
static JAVASCRIPT: LangSpec = LangSpec::new(
    "javascript",
    js_language,
    include_str!("../queries/javascript.scm"),
);
static JSX: LangSpec = LangSpec::new("jsx", js_language, include_str!("../queries/javascript.scm"));

pub static ALL: [&LangSpec; 4] = [&TYPESCRIPT, &TSX, &JAVASCRIPT, &JSX];

pub fn spec_for(language: &str) -> Option<&'static LangSpec> {
    ALL.iter().find(|s| s.name == language).copied()
}
