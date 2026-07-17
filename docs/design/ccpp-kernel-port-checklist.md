# C/C++ kernel port (R7a) — the bug-for-bug checklist

**Status:** survey COMPLETE; grammars VENDORED + suite-green (2026-07-17):
tree-sitter-c v0.24.2 (`b780e47`, parser.c `f2883ff9…`) + tree-sitter-cpp
v0.23.4 (`f41e1a0`, parser.c `2a35a43b…`, scanner.c `cf60387d…`), built with
ts-cli 0.25.10 from checked-in parser.c, in `src/extraction/wasm/` +
VENDORED_WASM_LANGS. The walker PR adds the SAME-version crates + kernel
grammar registry (kernel-grammar-parity then pins the alignment). Walker +
gates not started.
This is §0a-recipe step 1's output for c/cpp: every TS-side branch the walker
must mirror, with file:line anchors into the reference implementation. Read it
WITH `docs/design/rust-kernel-migration-plan.md` (§0a recipe, §5 gates).
Companion walkers to crib structure from: `codegraph-kernel/src/tsjs/` (multi-
dialect module), `java.rs`, `go.rs` (receiver QNs), `python.rs`.

## Architecture decisions (already made by the plan)

1. **preParse stays TS-side and is HOISTED to the route point.**
   `tryKernelExtract(filePath, source, lang)` currently receives RAW source
   (`tree-sitter.ts:6707`); the wasm path applies `extractor.preParse` inside
   `TreeSitterExtractor` (`tree-sitter.ts:488`). For kernel-routed c/cpp, apply
   the SAME preParse before the kernel call so both arms parse identical
   blanked bytes — all seven blanking passes (`preParseCppSource` /
   `preParseCSource`, `languages/c-cpp.ts:698/750`) then need NO Rust port,
   and every offset survives (they're all equal-length-space replacements).
2. **Metal + CUDA ride the cpp route** (corrected from the first draft):
   `.metal`/`.cu` map to language `'cpp'` at detectLanguage (grammars.ts:135),
   so there is no separate routing decision — when cpp routes to the kernel,
   those files come along as blanked cpp. The preParse hoist MUST pass
   `filePath` (the extension gates Metal-attribute blanking) and the CUDA
   content gate rides for free. Their suite tests are the parity insurance.
3. **One walker module, dual language** (`codegraph-kernel/src/ccpp/`), flagged
   c vs cpp like `tsjs/` flags its four dialects. Grammars: tree-sitter-c +
   tree-sitter-cpp crates, wasm vendored from the SAME tags (sha-matched
   parser.c + scanner, ts-cli 0.25.10). Upgrade the production wasm FIRST and
   get the full suite green before the walker exists (isolate grammar-bump
   effects, as R2 did for TS/JS).

## Extractor configs (languages/c-cpp.ts — read the whole file when porting)

**cExtractor (line 180):** functionTypes=[function_definition]; NO
class/method/interface types; structTypes=[struct_specifier];
enumTypes=[enum_specifier]; enumMemberTypes=[enumerator];
typeAliasTypes=[type_definition]; importTypes=[preproc_include];
callTypes=[call_expression]; variableTypes=[declaration];
nameField=declarator; isConst = any child `type_qualifier` with text
`const`; getReturnType = extractCppReturnType; resolveTypeAliasKind =
typedef enum/struct with body → that kind (anon inner specifier takes the
typedef's name); extractImport: `system_lib_string` → strip `<>`, else
`string_literal>string_content`; signature = full `#include` line.
recoverMangledName = recoverMangledCppName (post-parse salvage, PORT).

**cppExtractor (line 755):** adds classTypes=[class_specifier] with
**skipBodilessClass** (forward decls / elaborated refs mint no node, #1093);
methodTypes=[function_definition] (method vs function decided by
isInsideClassLikeNode); typeAliasTypes += alias_declaration (`using X = …`);
resolveName = extractCppQualifiedMethodName (line 75: macro-recovered name
first, else LAST `::` segment of the declarator's qualified_identifier —
found by BFS that SKIPS parameter_list + trailing_return_type, line 13);
getReceiverType = extractCppReceiverType (line 86: the qualifier prefix,
`stripCppTemplateArgs`-normalized — multi-line template args must not leak
newlines into qualifiedName, #1286/NAME_MAX); getReturnType =
extractCppReturnType → normalizeCppReturnType (line 122: smart-ptr/optional
unwrap to pointee, cv/template/ptr strip, last `::` segment, primitives →
none — set CPP_NON_CLASS_RETURN line 108); getVisibility = nearest preceding
`access_specifier` scan in the parent's children (line 785);
isMisparsedFunction (line 811): name starts `namespace`, name ∈
{switch,if,for,while,do,case,return}, or isMacroMisparsedTypeDecl (line 261:
bodyless class/struct specifier in `type` + non-function_declarator
declarator → DROP the node).

**Name-salvage helpers to port exactly:** recoverCppMacroDefinedName (line
49 — ALL-CAPS-with-underscore parsed name + first param a LONE lowercase
type_identifier + ≥2 params + NO other lone-identifier param; gtest
`TEST_F(Fixture, Name)` / `PYBIND11_MODULE(ext, m)` bail);
recoverMangledCppName (line 406 — only already-mangled names, `Ret (name)`
idiom left alone, last token before `(`, primitive/keyword guard);
stripCppTemplateArgs (line 157 — depth-counted removal of every balanced
`<…>`); cDeclaratorIdentifier (tree-sitter.ts:234 — declarator chain walk,
function_declarator → null, 12-hop guard).

## tree-sitter.ts branches (anchors as of `705e501`)

| Line | Mechanism | Must-mirror details |
|---|---|---|
| 962 | cpp namespace prefix stack (#1291) | named `namespace_definition` pushes its name (C++17 `a::b` as written) onto the QN prefix while walking children; anonymous falls through bare |
| 2795 | C file-scope variables | only when NO function ancestor; iterate declarators; accept ONLY init_declarator / pointer_declarator / array_declarator — a BARE identifier declarator is a macro-prototype misparse, skip (loses uninit scalars by design); name via cDeclaratorIdentifier; signature `= <first 100 chars>`; kind constant/variable via isConst |
| 4313 | explicit operator calls (#1247) | callee = `function` field + ERROR-wrapped `operator_name` sibling; compact symbolic spacing (`operator *`→`operator*`, word forms keep space); receiver `->`→`.`; DROP unless receiver is `this` (bare name) or simple identifier/member chain (silent miss over wrong edge) |
| ~4340 | field_expression method calls | `recv.method`/`ptr->method` → `recv.method`; SKIP_RECEIVERS {self,this,cls,super} → bare name; LITERAL receiver → emit nothing (#1230) |
| 4398 | call-result receivers (#645/#608) | receiver is call_expression → `<innerCallee>().<method>` re-encode (c AND cpp in the gate list) |
| 4534 | template-arg strip on callees | callee contains `<` and NOT `operator` → stripCppTemplateArgs (CUDA launch sites post-blank take this shape) |
| 4545 | local fn-ptr call fan-out (#932-adjacent) | bare-identifier callee found in cppLocalFnPtrs[callerId] → emit one `calls` ref PER recorded target, suppress the local name |
| 5173 | stack construction (#1035) | cpp `declaration` where `type` ∈ {type_identifier, template_type, qualified_identifier} and any init_declarator has `value` ∈ {argument_list, initializer_list} → extractInstantiation |
| 5183 | fn-ptr binding recording | inside a body: `declaration>init_declarator` (identifier declarator) or `assignment_expression` (identifier left); value must be pointer_expression whose child(0) is `&`; target ∈ {identifier, template_function, qualified_identifier}, template-stripped; per-callerId map of per-local Sets (branch reassignments accumulate) |
| 5408 | base_class_clause → extends (#1043) | per base: type_identifier / qualified_identifier / template_type, stripCppTemplateArgs'd; access-specifier keywords skipped |
| 4740 | static member refs — **cpp only** (c not in STATIC_MEMBER_LANGS, line 345) | `Foo::BAR` value reads → `references` edge; VERIFY the MEMBER_ACCESS_TYPES shapes for qualified_identifier + the call-callee skip during the port |
| — | value-reference edges | **c: YES** (VALUE_REF_LANGS line 401), **cpp: NO**. Port the value-ref machinery for C only (crib go.rs / tsjs — shadow prune, scope stack, MAX_VALUE_REF_NODES cap, CODEGRAPH_VALUE_REFS=0 kill) |
| — | fn-ref capture (#756) | function-ref.ts:376: `c: cFamilySpec()`, `cpp: cFamilySpec({ addressOfOnly: true })`; note line ~582: `&Cls::m` exemption from the bare-ids-are-free-functions rule — read cFamilySpec fully when porting |
| 355 | INSTANTIATION_KINDS | includes new_expression → cpp `new Foo(...)` instantiates (verify the cpp entry list when porting) |

**Generic paths c/cpp share with ported languages** (already mirrored by
java.rs/python.rs/go.rs — re-verify each against c/cpp fixtures rather than
re-deriving): extractFunction/Method QN via scope stack + receiverType
(`Recv::name` like Go), struct/enum/enum_member extraction, typedef →
type_alias (+ resolveTypeAliasKind kind override), imports, docstrings
(preceding `comment` nodes — docstring.rs already handles C markers incl. the
CRLF semantics from #1329), contains edges, signature truncation in UTF-16
units, MAX_FILE_SIZE / generated-file skips, `has_error()` → `defer:`.

## Gates (per plan §5, no exceptions)

- Torture fixtures: `torture.c` (fn-ptr tables, typedef enum/struct, file-scope
  consts incl. multi-declarator, macro-prototype misparse shape, value-refs) +
  `torture.cpp`/`torture.hpp` (namespaces incl. C++17 nested, out-of-line
  `Cls::method` defs, templates + template bases, operators incl. spaced call
  sites, stack construction, local fn-ptrs, UE-macro shapes THROUGH the
  hoisted preParse, `using` aliases, anonymous namespace, access specifiers).
- Parity sweeps + full-init dump-diffs byte-identical: redis + git (C),
  fmt + a protobuf-class repo (C++), plus a UE-macro-heavy spot-check
  (blanking-hoist parity) — then linux in cg1212 (expect parse 338s →
  ~120–180s at the 2c envelope; graph counts must stay 2,048,664/6,405,964).
- Deferral-rate guard <10%; suite; changelog rides the existing kernel entry.
- DEFAULT_ROUTED += c, cpp only after ALL of the above.
