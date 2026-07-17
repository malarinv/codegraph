# Rust extraction-kernel migration plan + post-kernel roadmap

**Audience:** the agent/engineer executing the native-kernel project. Self-contained handoff:
context, current state, per-language tracker, gates, and the follow-on roadmap.
**Companion:** `docs/design/native-extraction-kernel.md` (architecture + spike detail).
**Written:** 2026-07-16, after the perf arc that shipped #1305, #1320, #1321, #1322, #1323.

---

## 0. Execution order (the whole plan as one checklist)

Work top to bottom; each step has a section below with the detail.

- [x] **R1. Scaffold the napi-rs crate** (`codegraph-kernel`): buffer contract, generic
      `.scm` emitter, build-pipeline integration, `CODEGRAPH_KERNEL=0` kill switch,
      wasm fallback, grammar-source-parity CI. (§3) — **done 2026-07-16, see §3a.**
- [x] **R2. Port TypeScript/JavaScript extraction** (tsx/jsx included) as language one. (§4)
      — **ported 2026-07-16, see §4a**: full-fidelity Rust walker, byte-parity on this repo
      (353 files) + excalidraw (643 files) + torture fixtures; extraction 2.6× single-thread.
      R3's gate (large repo, retrieval invariants, agent A/B, Linux/Windows) still gates
      default-on.
- [ ] **R3. Run TS/JS through the equivalence gate** — graph parity, retrieval
      invariants, agent A/B, perf + control repo. Ship behind the env flag, then default-on. (§5)
- [ ] **R4. Port Java** → re-run the dubbo benchmark → the cbm-parity headline. (§4, §6)
- [ ] **R5. Port Python, Go.** (§4)
- [ ] **R6. Kernel-scale re-validation** in the cg1212 container (expect parse 6m → ~2m). (§6)
- [ ] **R7. Long-tail languages opportunistically** per the tracker; T3 may stay TS forever. (§4)
- [ ] **P1. Kernel-scale resolution speed** — the 19.5-min sequential wall at 2M nodes. (§7a)
- [ ] **P2. Arc 3, graph richness** — in priority order: test edges → code metrics →
      read/write refs → raises → doc sections → IaC nodes. Each behind the standard gate. (§7b)
- [ ] **P3. Parked items** — only with explicit maintainer approval. (§7c)

---

## 1. Mission and the numbers that motivate it

CodeGraph's remaining fresh-index gap vs codebase-memory-mcp (cbm) is the parse+extract
phase, and its floor is per-node JS↔WASM marshaling — proven, not suspected:

| Measurement (2026-07-16, M3 Pro) | Result |
|---|---|
| dubbo (4,402 Java files) parse-loop, current 7-wasm-worker pipeline | 4,700ms |
| Same files, Rust tree-sitter parse+walk, rayon (spike) | **202ms** |
| Same, single Rust thread | 1,067ms |
| dubbo fresh init today / cbm | 11.1s / 7.1s (1.55×) |
| Linux kernel, same 2-CPU/6GB container | **we complete 27min; cbm dies at 0.16%, twice** |

Spike source: session scratchpad `cg-kernel-spike/` (tree-sitter 0.25 + tree-sitter-java,
TreeCursor walk touching kind/range/name-field, flat-row output). Reproduce before starting —
it's ~80 lines and doubles as the emitter's seed.

Expected end state: parse-loop 4.7s → ~1.0–1.5s on dubbo-class repos → total ≈ 7.5s,
**parity with cbm on their best surface**, while keeping every win we already hold
(sync 2.4–2.8×, agent A/B decisive, call-graph density 1.3–2.3×, byte-identical
determinism, constrained-hardware envelope).

## 2. What the kernel is — and the boundary that makes it safe

One napi-rs crate (`codegraph-kernel`) linking tree-sitter's C library and native grammars.
Input `(filePath, content, language)` per file; output **flat typed buffers** (nodes, edges,
unresolved refs) — one boundary crossing per file. It replaces ONLY the parse+extract walk
inside the parse workers, behind the existing `ExtractionResult` contract.

**Never ported (works unchanged for all languages from day one):** name-matcher +
import-resolver, all framework resolvers (`src/resolution/frameworks/`), all 36 synthesis
passes, MCP/explore, sync/watcher, installer. They consume the graph and raw source, not
the parse tree.

**Coexistence is permanent:** a language routes to the kernel only after its gate passes;
everything else stays on the wasm path forever if need be. No flag-day. Rollback per
language = flipping the route.

**Distribution:** prebuilt `.node` per platform through the existing release-bundle
pipeline (`scripts/build-bundle.sh` + per-platform npm packages); the same crate compiled
to wasm is the universal fallback. Zero-native-build-on-install stays true.

## 3. Phase 0 — scaffold (do first, ~days)

1. `codegraph-kernel/` crate: napi-rs, tree-sitter C, rayon optional (workers already
   parallelize per-file — start synchronous per call, one kernel call per file from the
   existing `ParseWorkerPool` workers; do NOT rebuild the pool).
2. Buffer contract: decide the flat encoding (suggest: one `Buffer` per table,
   fixed-width rows + a string arena; version byte first). Write the TS decoder next to
   `parse-worker.ts`.
3. Generic emitter driven by per-language `.scm` query files + a small per-language Rust
   config (node-kind → NodeKind mapping, name-field conventions). Escape hatch: a
   per-language `post(buffers, source)` TS hook for logic queries can't express.
4. Build integration: napi prebuilds wired into the release workflow next to the Node
   bundles; `CODEGRAPH_KERNEL=0` kill switch; wasm fallback auto-selected when the
   `.node` is absent (source runs, unsupported platforms).
5. CI: assert native grammars and wasm grammars are built from the SAME grammar source
   revisions (ABI drift between paths would make per-language routing non-deterministic).

### 3a. Phase 0 — SHIPPED 2026-07-16 (what exists and the decisions made)

- **Crate:** `codegraph-kernel/` (napi 3, tree-sitter 0.25, no CLI dependency —
  `scripts/build-kernel.sh` does cargo build + stage into
  `codegraph-kernel/prebuilds/<platform>-<arch>/codegraph-kernel.node`; `npm run
  build:kernel`). Exports `extractFile`, `contractInfo`, `grammarInfo`.
- **Buffer contract v1:** five Buffers (meta/nodes/edges/refs/arena), fixed-width LE rows,
  string arena with `(offset,len)` refs, `0xFFFFFFFF` = absent, version byte first, node
  IDs computed Rust-side (sha256, byte-identical to `generateNodeId` — pinned by test),
  tri-state bool flags, `extraJson` escape slot per node row, and a RESERVED u32 metrics
  slot (Arc 3.2). Layout doc lives twice and must match: `codegraph-kernel/src/buffers.rs`
  ↔ `src/extraction/kernel/layout.ts`. NODE_KINDS/EDGE_KINDS array ORDER in src/types.ts
  is wire contract now (EDGE_KINDS became a runtime array for this).
- **Emitter:** generic, `.scm`-driven (`@def.<NodeKind>` + `@name` + `@ref.<EdgeKind>`
  capture convention), scope stack by byte-range nesting → `::`-joined qualifiedNames,
  contains edges, refs attached to innermost enclosing def (file node fallback) — the
  TreeSitterExtractor conventions. Seed TS/JS queries are SMOKE-level only; R2 replaces.
- **Routing:** inside `extractFromSource` (tree-sitter.ts) — `tryKernelExtract` first,
  wasm `TreeSitterExtractor` as fallback (also per-FILE fallback on any kernel error).
  DEFAULT_ROUTED is EMPTY; dev opt-in via `CODEGRAPH_KERNEL_LANGS=<langs|all>`; global
  kill switch `CODEGRAPH_KERNEL=0`; loader verifies ABI + kind tables before routing
  (stale .node → silent wasm, `CODEGRAPH_KERNEL_DEBUG=1` to see why). The escape hatch
  landed as `post(result, source)` over the DECODED result (not raw buffers) — decoded
  is what TS logic wants; see POST_PASSES in `src/extraction/kernel/index.ts`.
- **Grammar parity (the §3.5 CI) — and a decision that changed the wasm path:** the
  parity test (`__tests__/kernel-grammar-parity.test.ts`, behavioral: ABI + node-kind +
  field tables compared id-by-id) caught on day one that tree-sitter-wasms ships
  2023-era TS/JS grammars (^0.20.x) vs crates.io current. Resolution: **vendored fresh
  wasm into `src/extraction/wasm/` built from the exact crate revisions** —
  tree-sitter-typescript v0.23.2 (f975a62) for typescript+tsx, tree-sitter-javascript
  v0.25.0 (44c892e) for javascript+jsx — from each repo's CHECKED-IN parser.c (no
  `generate`), tree-sitter-cli 0.25.10, emcc. So the production wasm TS/JS grammars are
  UPGRADED as of this change (full suite green, 2456 tests) and **R2/R3 parity diffs
  are grammar-neutral**. Bump crate + vendored wasm together, or the parity test fails.
- **Release wiring:** `kernel` matrix job in release.yml (macos-14 ×2 targets,
  ubuntu-22.04, ubuntu-22.04-arm, windows-latest ×2 — all continue-on-error: kernel is
  optional, a toolchain flake never blocks a release) → artifacts → `release/kernel/` →
  build-bundle.sh stages `lib/kernel/codegraph-kernel.node` when present. The release
  job runs the kernel tests with `CODEGRAPH_KERNEL_EXPECT=1` (missing binary = FAILURE
  there, skip elsewhere).
- **Loader search order:** `CODEGRAPH_KERNEL_PATH` → `<pkgroot>/kernel/` (bundle) →
  `<pkgroot>/codegraph-kernel/prebuilds/<plat>-<arch>/` (source runs).
- **Known R2 gate item:** native columns are UTF-8 byte offsets; web-tree-sitter's are
  UTF-16-derived — column NUMBERS on non-ASCII lines will differ in parity dumps
  (text, lines, IDs unaffected). Classify or normalize when it shows up.
  **RESOLVED in R2:** the walker emits UTF-16 columns natively (util::col16), and JS
  string-slicing semantics (signature truncation at 100/80/120 units) are reproduced in
  UTF-16 units too — no column/slice diff class exists.

### 4a. R2 — TS/JS port SHIPPED 2026-07-16 (and a §3 design revision)

- **The generic `.scm` emitter is superseded.** Real TS/JS parity needs logic queries
  can't express (extractCall's receiver-qualified callees, store/RTK/component
  recognition, fn-ref capture+gating, value-ref shadow pruning, docstring wrapper
  climbs) — so R2 replaced the R1 query emitter with a **bespoke per-language walker**
  (`codegraph-kernel/src/tsjs/`, ~1,900 lines) that mirrors `TreeSitterExtractor`'s
  TS/JS paths function-for-function, bug-for-bug. emitter.rs + queries/ are deleted
  (git has them); expect T1 languages (java/python/go) to be walkers too. The
  `post(result, source)` TS escape hatch remains available but TS/JS needed none.
- **Parity evidence (macOS):** `scripts/kernel-parity.mjs` (multiset diff of
  canonicalized nodes/edges/refs per file, FULL objects) — this repo 353/353 files,
  excalidraw 643/643 files (10,650 nodes / 10,726 edges / 68,307 refs), plus
  checked-in torture fixtures (`__tests__/fixtures/kernel-parity/`) covering
  components/HOCs/styled, zustand-through-middleware, RTK endpoints+hooks, vuex/pinia,
  fn-refs (incl `this.x` + shadowing gates), value-refs (incl the shadow prune),
  decorators, enums, type-alias members + tuple contracts, re-exports, JSX. Kept alive
  in `npm test` by `__tests__/kernel-tsjs-parity.test.ts` (strict full-object compare).
- **One decoder bug found by the strict compare:** decode.ts pre-filled
  `filePath`/`language` on refs; wasm extractors leave them unset (the store
  denormalizes via `?? filePath`). Fixed — the seam contract is "exactly what
  extractFromSource returns", not "what the store makes of it".
- **Perf (M3 Pro, excalidraw 643 files / 7MB):** extraction single-thread 487ms kernel
  vs 1,255ms wasm (**2.6×**, identical outputs). End-to-end `init` on an 11-core host
  moves only ~3.4s → ~3.2s — parse is a small, already-pool-parallelized slice there;
  the win concentrates on constrained hardware (2-core CI class) and kernel-scale
  parse (R6). Headroom if R4's dubbo target needs it: arena interning, memoized
  UTF-16 line prefixes, and skipping wasm-grammar loads in workers for kernel-routed
  languages (worker cold-start).
- **Not yet done (R3 gate):** large-repo parity (vscode-class), full-repo dump-diff
  through the DB, retrieval invariants, agent A/B, Linux docker + Windows VM parity
  runs, control-repo perf. Routing stays opt-in (`CODEGRAPH_KERNEL_LANGS`) until then.

## 4. Per-language tracker

Tiers: **T1** = mostly `.scm` + mapping config. **T2** = needs bespoke pre/post passes kept
in TS (listed). **T3** = not a plain tree-sitter walk (standalone/multi-grammar extractor)
— migrate last or never; wasm/TS path is a fine permanent home.

The user-facing language contract is `README.md → Language Support` (34 logos incl.
Metal, CUDA, Terraform/OpenTofu, Pascal/Delphi). Keep this tracker in sync with it —
every README language must have a row here, even the ones that only ride another
language's port.

Grammar column: `crates.io` = mainstream native grammar crate exists; `vendored` = we ship
a rebuilt/patched wasm (ABI-15) and the kernel must compile OUR fork natively — verify
parity before porting the language.

| Language(s) | Today | Tier | Grammar source | Migration notes / known traps | Status |
|---|---|---|---|---|---|
| typescript, tsx, javascript, jsx | `languages/typescript.ts`, `javascript.ts` + shared branches | T1 | crates.io | First target. Value-reference edges (#895/#897) and component recognition (#841 forwardRef/memo/styled) must survive — they're extraction-side. Largest test surface; gate is strictest here. **PORTED (§4a) — value-refs, component recognition, fn-refs, stores all byte-parity; awaiting the R3 gate before default-on.** | ◐ |
| java | `languages/java.ts` | T1 | crates.io | Second target; unlocks the dubbo-parity claim. Lombok member synthesis (#912) is a NODE synthesizer hook in extraction (`synthesizeMembers`) — port or keep as TS post-pass. | ☐ |
| python | `languages/python.ts` | T1 | crates.io | Third. Decorator extraction feeds framework route detection — parity required. | ☐ |
| go | `languages/go.ts` | T1 | crates.io | Third (tie). Value-reference edges ship here too (#897). | ☐ |
| ruby, php | dedicated files | T1 | crates.io | Straightforward; PHP property-receiver shapes (#1220/#1251) are RESOLUTION-side, unaffected. | ☐ |
| csharp | `languages/csharp.ts` | T1 | crates.io | Plain. | ☐ |
| rust, dart, scala, lua, luau, r | dedicated files | T1 | crates.io (luau/r/scala: verify crate freshness vs our wasm) | Long-tail T1; port opportunistically after the big five. | ☐ |
| kotlin | `languages/kotlin.ts` | T1½ | crates.io | Expect/actual pairing is synthesis-side (fine); extraction is clean but validate against a KMP repo. | ☐ |
| swift | shared + dedicated branch | T1½ | crates.io | **Trap:** in-class property extraction lives in `tree-sitter.ts`'s DEDICATED branch, not `swift.ts` (#1020 — Alamofire went 0→348 props). Gate on Alamofire. | ☐ |
| c, cpp | `languages/c-cpp.ts` | **T2** | crates.io | Keep as TS pre-passes: `blankCppExportMacros`/`blankCppInlineMacros` (UE `class MACRO Name` phantom-function misparse, #1096–#1102, CARLA 440→6), in-body reflection collapse guard (#1206), content-based `.h` C-vs-C++ detection. | ☐ |
| metal, cuda | dialects over the cpp grammar | **T2** (rides c/cpp) | crates.io (cpp) | README-listed as first-class languages. Both are dialect-gated cpp: Metal = specifier/`[[attribute]]` blanking (#1121, the preParse-takes-filePath pattern); CUDA = `<<<>>>` blanking + content-gated `.h` (#1172). Their pre-passes must run before the kernel parse or stay TS-side; gate them WITH the c/cpp port, not separately. | ☐ |
| objc | `languages/objc.ts` | T2 | crates.io | Rides the c-cpp trap family; RN bridge extraction feeds `rnCrossPlatformEdges` (synthesis-side, fine). | ☐ |
| arkts | `languages/arkts.ts` | T2 | **vendored** (harmony-contrib) | Dot-prefixed refs + decorator-gated matching fixed 36,840 wrong edges — that logic must port exactly or stay TS-side. Compile our grammar fork natively. | ☐ |
| pascal | `languages/pascal.ts` | T2 | **vendored** | Paired with dfm-extractor (T3); `extractPascalDefProc` indexed lookups. | ☐ |
| vbnet | `languages/vbnet.ts` | T2 | **vendored, patched + external scanner** | Our wasm is a patched grammar WITH a C external scanner — the kernel must build that scanner; ts-cli 0.24 dropped `\p{...}` classes during the original build (#1164). Highest grammar-build risk of any language. | ☐ |
| cobol | `languages/cobol.ts` | T2 | **vendored fork** | Paragraph-extent reconstruction + copybook resolution are extraction logic (#1161, CardDemo 43/44). Port carefully or keep TS post-pass. | ☐ |
| erlang | `languages/erlang.ts` | T2 | **vendored (WhatsApp/ELP)** | npm `tree-sitter-erlang` is HIJACKED — never source from it (#1165). gen_server dispatch is synthesis-side (fine). | ☐ |
| nix | `languages/nix.ts` | T2 | **vendored (ABI-15 rebuild)** | Option-path synthesizer is synthesis-side; the `===`-always-false → `.equals()` lesson (#1190) is wasm-binding-specific and disappears natively — still gate on nixpkgs (44k files). | ☐ |
| solidity | `languages/solidity.ts` | T2 | **vendored** | `modifier_invocation` outside body walk (#1170) is extraction-side; port it. | ☐ |
| terraform | `languages/terraform.ts` | T2 | **vendored** | `:`-scoped refs for module-boundary bridging (#1173); metadata does NOT persist — re-read source (#1174). | ☐ |
| cfml, cfscript, cfquery | `cfml-extractor.ts` + 3 grammar files | **T3** | **vendored ×3** | 3-grammar family with BOM-sensitive dialect sniffing (#1118/#1153–55). Leave on wasm until the very end, possibly forever. | ☐ |
| svelte, vue, astro, liquid | standalone extractors | **T3** | n/a (custom/embedded parsing) | Not tree-sitter walks. Permanent TS home is acceptable — file counts are small and these repos are small. | ☐ |
| dfm (Delphi forms), razor, mybatis XML | standalone extractors | **T3** | n/a | Same as above. mybatis pairs with a synthesis pass (fine). | ☐ |

**Do-not-regress invariants during any port** (extraction-side, will show up in the gate):
node metadata is re-read from source, never persisted; parse commits stay in FILE ORDER
(#1015); `MAX_FILE_SIZE` skip; generated-file detection; `CODEGRAPH_PARSE_WORKERS`
semantics; framework `extract()` hooks keep running TS-side per file after the kernel pass.

## 5. Equivalence gate (run per language, no exceptions)

Byte-identity vs hand-written extractors is NOT expected — the gate is behavioral parity:

1. **Graph parity:** fresh-index 3 real repos (small/medium/large for the language) on
   wasm-path vs kernel-path builds. Dump with the `dump-graph.mjs` pattern (natural keys).
   Node/edge/ref deltas ≤0.5% AND every diff category manually classified (the 13-edge
   supertype-visibility bug this week was caught exactly this way — small diffs are real).
2. **Retrieval invariants:** the language's canonical flows still connect end-to-end in
   `codegraph_explore` (playbook: `docs/design/dynamic-dispatch-coverage-playbook.md`);
   node counts stable; synthesized-edge spot-check.
3. **Agent A/B non-regression** per the standard methodology (CLAUDE.md): `--model sonnet
   --effort high` ALWAYS, ≥2 runs/arm, pre-warmed daemon, `CODEGRAPH_NO_PROMPT_HOOK=1`,
   forbid subagent delegation in the prompt.
4. **Perf:** fresh-index improves on the language's repos; a NON-migrated control repo is
   unchanged; suite green; Linux docker + Windows VM passes for platform-sensitive bits.

## 6. Rollout order and expected wins

1. **TS/JS/TSX/JSX** — most indexed files in the funnel; excalidraw 3.3s → ~2.3s expected.
2. **Java** — dubbo 11.1s → ~7.5s expected (**the cbm-parity headline**).
3. **Python, Go** — rounds out ~90% of real-world indexed files.
4. Kernel-scale re-run in the cg1212 container after (2): parse 6.0m → ~1.5–2m expected.
5. Long tail opportunistically; T3 possibly never — that's fine by design.

Measurement discipline (hard-won this week — do NOT relearn these):
- Profile first. Ideas killed by measurement this week: sorted-chunk inserts (zero),
  statement-batching the persist (zero — B-tree maintenance is the cost), RAM-disk/
  in-memory DB build (SLOWER — fastInit already writes at page-cache speed).
- `CODEGRAPH_SYNTH_TIMINGS=1` now emits full phase walls (`[phase-timing]`) + pool/batch
  timings. UI distorts phase walls — pipe stdout away.
- Check host load before timing (iOS simulators inflated every phase ~30%); the
  Monitor-on-loadavg pattern (fire <3.5) gives clean windows.
- `grep` is aliased to ugrep and silently treats `callback-synthesizer.ts` as binary —
  use `grep -a`.

## 7. AFTER the kernel: the follow-on roadmap (in order)

### 7a. Kernel-scale resolution speed
The kernel makes parse fast; at Linux-kernel scale resolution is now the wall (19.5min
sequential in the 2-CPU container; the resolver pool requires ≥4 cores to engage).
Steps: re-run cg1212 validation on ≥4-core allocation (pool + parallel synthesis engage);
profile; likely levers: worker count scaling, batch size at scale, `warmCachesYielding`
on multi-GB DBs. Target: kernel <10min on a normal 8-core host.

### 7b. Arc 3 — graph richness (forensics-backed; adopt cbm's real extras, skip inflation)
Priority order, each gated by the standard A/B + node-explosion probes:
1. **Test→subject edges** (first-class `tests` edges at index time; we compute covering
   tests at query time today; cbm materializes 14.8k on dubbo). Feeds test-gap detection
   (Lite headline) + Pro risk signals. Cheapest, do first.
2. **Per-node code metrics** (complexity, cognitive, `is_test`, `is_entry_point`,
   param counts) — computed during extraction (the kernel makes this nearly free —
   design the buffer contract with a metrics slot!). Feeds Pro risk-ranking verdicts +
   explore ranking de-noise.
3. **Read/write distinction on references** (`USAGE` vs `WRITES`). The measured agent
   frontier ("who mutates this state" — the canvasNonce class). HIGHEST value, HIGHEST
   risk: scope to exported/state-relevant symbols; the tracking-every-local explosion is
   the known failure mode (#999/#1212 class). Full validation methodology.
4. **Exception-flow edges** (`raises`) — throw→handler; moderate.
5. **Doc Section nodes** (markdown headings as nodes, linked to code) — maps onto Pro's
   synced-business-docs story.
6. **IaC nodes** (k8s/docker/kustomize as graph nodes with cross-references).
NOT worth chasing (verified in their cache schema): per-variable node inflation (85% of
their node count), DB size parity (theirs is ~60% allocation slack), similarity vectors
in the core engine.

### 7c. Deferred/parked (needs explicit approval before starting)
- Single-file SEA binary (distribution polish; zero speed).
- Team-shared graph artifact (cbm's `graph.db.zst` idea — good, but design it for the
  Pro shared-worker story, not as an OSS clone).
- Full native rewrite: rejected with data — the moat (2,444 tests, byte-identical
  determinism, this week's two caught-by-gate bugs) lives in the TS reference.

## 8. Context for the executing agent

- House rules live in `CLAUDE.md` (repo root) — the retrieval invariants, A/B model
  policy, release rules (never `npm publish`/push tags), changelog format.
- This week's PR trail tells the story and the style: #1305, #1320 (checkpoint deferral +
  double-buffered persist; THE invariant: batch k+1 READS batch k's edges — supertype
  walks — so edges insert before fan-out), #1321 (parallel synthesis via pool reuse,
  registry order = merge order), #1322 (bulk edge load, identity index stays), #1323
  (kernel-scale hardening: skip-don't-retry-on-main >1.5M nodes, yielding index recreate).
- Every perf PR shipped byte-identical with the dump-diff gate; keep that bar.
- Competitive context (validated 2026-07-16): cbm wins medium-repo fresh index 1.55–1.8×
  (their RAM-first design); we win sync 2.4–2.8×, agent A/B (their 14 tools drew ZERO
  calls in 8/8 runs), call-graph density 1.3–2.3×, and the constrained-hardware envelope
  (Linux kernel on 2-CPU/6GB: we complete in 27min, they die at 0.16% — their speed IS
  their memory floor). The kernel project closes their last number without giving up any
  of ours.
