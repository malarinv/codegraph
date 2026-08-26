# codegraph ui — design specification

Authoritative visual + interaction spec for the `codegraph ui` viewer (Kommandr epics CG-39 → CG-48 → CG-56;
Pro layers in docker-app DOCKERAPP-10). Companion to the design proposal ("Reading the graph") and the
interactive prototype; the prototype's stylesheet is appended verbatim at the end and is the source of truth
for every measurement below. Screenshots: `CodeGraph/codegraph-web-prototype/screenshots/` (also attached to
the Kommandr epics).

Design proposal: https://claude.ai/code/artifact/58336c87-9780-4018-8c04-37fe53236e96
Prototype: https://claude.ai/code/artifact/304bffb6-72d6-49c7-8f3a-9e4f244909f8
Prototype sources: `CodeGraph/codegraph-web-prototype/` (`proto.css`, `proto.js`, `extract.mjs`, `build.mjs`)

## 1. Principles (non-negotiable)

1. One symbol at a time — no whole-graph picture, no node-link neighborhood graph (decided).
2. Code order is the coordinate system — layouts by source line or dependency layer; deterministic; never force-directed.
3. Edges grow out of the code — every call edge is drawn from the line that makes the call (gutter port → callee row at that height).
4. Direction is spatial — callers left, callees right, flows read left→right, map dependencies point down.
5. Collapse the tails, show the counts — hubs badge (fan-in ≥ 40), tests fold, confidence < 0.6 folds ("uncertain"), outside-index counts; nothing silently dropped.
6. Honesty in the pixels — confidence = line style; heuristic (synthesized) edges dashed + wiring site; boundaries announced; drift banners; "no test within 3 hops" badge.

## 2. Visual language

The engine's paper/ink editorial system (`site/src/styles/theme.css`): flat, hairline rules, **square corners everywhere**
(`border-radius: 0 !important` globally), no shadows, no gradients, sentence case, **no tiny all-caps tracked labels**,
one oxblood accent used only for focus/selection/edges, one amber used only for the "untested" warning.
Syntax highlighting is deliberately near-monochrome so the graph's edges are the only colour in the code.

### 2.1 Color tokens

| token | light | dark | used for |
|---|---|---|---|
| `--paper` | `#f7f6f2` | `#16150f` | page/body background (always set explicitly) |
| `--paper-2` | `#f1efe8` | `#1c1a14` | trail bar, inputs, hovered code line, figure grounds |
| `--press` | `#e8e6dd` | `#23211a` | hover fills, inline code background, bars |
| `--press-2` | `#dedbd0` | `#2c2a22` | reserved (pressed state) |
| `--ink` | `#16150f` | `#f3f1ea` | primary text, node borders, major rules |
| `--ink-2` | `#56544a` | `#b8b5a8` | secondary text, strings, callers' names when uncertain |
| `--ink-3` | `#87847a` | `#87847a` | tertiary text, comments, glyph borders, edge labels |
| `--ink-4` | `#b4b1a5` | `#5d5b52` | line numbers, resting connectors, dimmed map nodes |
| `--rule` | `#16150f` | `#f3f1ea` | top bar bottom rule, code/blast section rules |
| `--rule-soft` | `#d6d3c8` | `#34322a` | rail dividers, chips, card borders |
| `--rule-faint` | `#e6e3d9` | `#26241d` | row separators, map layer lines |
| `--accent` | `#7a2230` | `#d48b96` | oxblood: call-site links, current trail hop, hot connectors, selected map edges |
| `--accent-ink` | `#5e1a25` | `#e5a5ae` | accent text on accent-soft |
| `--accent-soft` | `#f0e3e5` | `#33201f` | tinted rows ("you came from here"), hot code lines |
| `--accent-line` | `#d9b3b9` | `#6b3a42` | accent borders/underlines at rest |
| `--amber` | `#8a5a0b` | `#d9a94a` | "No test reaches this within 3 caller hops" badge only |
| `--amber-soft` | `#f3e9d2` | `#2e2716` | that badge's fill |

Theme selection: define the light set on bare `:root`; redefine under `@media (prefers-color-scheme: dark)` guarded as
`:root:not([data-theme="light"])`; redefine again under `:root[data-theme="dark"]`. Never define a colour only inside a
media/`[data-theme]` block. `body { background: var(--paper); color: var(--ink) }`.

### 2.2 Type

- UI: **Archivo** 400/500/600/700 (fallback `-apple-system, BlinkMacSystemFont, 'Helvetica Neue', Arial, sans-serif`).
- Code, symbol names, file paths, chips, trail, map labels: **IBM Plex Mono** 400/500/600 (+ italic 400)
  (fallback `ui-monospace, 'SF Mono', Menlo, Consolas, monospace`).
- Scale: body UI `13px/1.45`; code `12.5px/20px`; symbol title `600 20px/1.2` mono, letter-spacing −0.01em;
  section labels (`Called by`, `Calls`, `Blast radius`) `600 13px` sans; rail rows `12.5px` mono name + `11px` sans meta;
  chips `11px` mono; line numbers `11px` mono in `--ink-4`; badges `11.5px`; map node label `13px` mono, count `11px`;
  flow card name `600 13px` mono, window `12px/19px` mono; trail `12px` mono. Headings sentence case, `text-wrap: balance`.
- Code token classes: comment `--ink-3`; string `--ink-2`; keyword weight 500 (same ink); number `--ink-2`; definition
  name on its own line weight 600; **call-site link** = `--accent`, underline `--accent-line`, offset 3px, hover/hot fill
  `--accent-soft`; uncertain link = `--ink-2`, dotted underline `--ink-4`; link to a symbol outside the index = `--ink-2`,
  underline `--rule-soft`, not clickable.

### 2.3 Kind glyphs

16×16 hollow square, 1px `--ink-3` border, letter in `500 9.5px` mono: `ƒ` function · `m` method · `C` class · `I`
interface · `S` struct · `T` type alias · `E` enum · `e` enum member · `k` constant · `v` variable · `p` property/field ·
`≡` file (dashed border) · `R` route · `⟨⟩` component · `N` namespace · `M` module · `Tr` trait · `U` union · `P` protocol.
Container/type kinds get a `--press` fill.

## 3. Layout and components

### 3.1 App shell
- Grid rows: **top bar 48px** / **trail bar 34px** / main. Top bar: brand (10px hollow square mark + "CodeGraph" 600 14px +
  "ui" in `--ink-3`), view tabs (`Map · Symbol · Flow`, 5px 10px padding, active = 2px `--ink` bottom border), search input
  (30px tall, `--paper-2` fill, `--rule-soft` border → `--ink` on focus, max-width 720px), project stats in `--ink-2` 12px.
  Bottom rule of the top bar is `--rule` (1px); the trail bar's is `--rule-soft`.
- Focus ring everywhere: `outline: 2px solid var(--accent); outline-offset: 1px`. `prefers-reduced-motion` disables transitions.

### 3.2 Symbol view (`#/s/<id>?t=<trail>&hl=<line>`)
- Grid: **left rail 300px** | stage `minmax(520px, 1fr)`; inside the stage: **center `minmax(480px, 1fr)`** | **right rail 320px**.
  Left rail has its own scroll; center + right rail scroll together in the stage (so callee rows stay aligned to lines).
  ≤ 1100px: 240px | `minmax(360px,1fr)` | 260px.
- Rail headers sticky, `12px 14px 8px` padding, 600 13px, count in `--ink-3`, hint text right-aligned `11.5px` (`← step up`, `step down →`).
- **Center**: padding `18px 22px 40px`. Header row: glyph, name (h1), kind word (`--ink-3` 12.5px, "· async · static · private"),
  location `file:start–end · N lines` (11.5px mono, file is a link). "in ClassName" breadcrumb 11.5px mono `--ink-3`.
  Badges row (gap 6px): `exported` · `hub · N callers` (border `--ink`) · tests badge (`Reached by tests · N files within 3 hops`,
  hollow 8px swatch) or amber warning (filled swatch). Signature 12px mono `--ink-2`, docstring 12.5px `--ink-2` max 70ch,
  relations row of chips (`extends X`, `implemented by …`, `uses types …` — chips 11.5px mono, `--rule-soft` border, 1px 6px).
- **Code block**: 1px `--rule` top border + 6px; each line is a grid `44px | 1fr | 18px` (line number right-aligned, 12px
  right padding; text `white-space: pre`; port cell). Hover line → `--paper-2`; hot/highlighted line → `--accent-soft`.
  **Port**: 6×6 square, 1px `--ink-3` border, positioned right 4px / top 7px; filled `--ink-3` when the line has a
  resolved (≥ 0.6) edge, hollow when only uncertain; accent fill+border when hot. Gap rows ("⋯ N lines without calls"):
  11px `--ink-4`, dashed `--rule-soft` top/bottom, 2px margin, indented 44px. Long bodies: head 80 lines + ±4-line windows
  around every call site; bodies ≤ 260 lines shown whole; containers show the outline instead of a body > 80 lines.
- **Right rail rows** (`.rrow`): absolutely positioned, `left 14px right 12px`, **height 34px**, grid `16px | 1fr` gap 8px,
  padding `0 6px`, 1px transparent border (→ `--ink` when keyboard-selected; `--accent-line` + `--accent-soft` when hot/origin).
  Desired y = center of first call-site line − 17px; place in line order with `y = max(desired, prevY + 34 + 6)`;
  the stage's min-height grows to fit. Name 12.5px mono (`×N` in `--ink-3` when called from N lines); meta 11px `--ink-3`:
  file (or "same file"), edge word (`creates`, `passes as value`), tags (`hub · N`, `outside index`, `via <synthesizedBy>`)
  as 10.5px bordered pills. Uncertain targets fold into a `<details>` ("+ Uncertain · N name-only matches, confidence < 0.6")
  placed 8px below the last row; "+N more calls into symbols outside the index" note 11.5px.
- **Connectors** (SVG overlay covering the stage content): one cubic Bézier per call line → row:
  `M x0,ly C cx,ly cx,ry x1,ry` with `x0 = center right edge − 10`, `x1 = rail left + 14`, `cx = (x0+x1)/2`.
  Resting: `--ink-4` 1px; hot: `--accent` 1.5px; uncertain: dasharray `2 3`; heuristic: dasharray `6 3` in `--ink-3`;
  origin (the edge you arrived by): `--accent`. Left rail draws no connectors (separate scroll container); the origin
  caller row is tinted instead. (Real build: consider converging left connectors into the header — open question.)
- **Left rail**: file groups (`.filegroup` padding `10px 14px 4px`; path 11px mono `--ink-3`, count bold `--ink-2`; the
  focus's own file first as "same file"); rows grid `16px | 1fr`, padding `5px 6px 5px 4px`, name 12.5px mono, meta row
  with edge-kind label + call-site chips (`:4657`, 11px mono, `--rule-soft` border, 0 4px; click = open caller at that line).
  Folds: `Tests · N calls from M files` (lists files), `Uncertain · N`. Origin row: `--accent-soft` fill + `--accent-line` border
  + "you came from here". Empty state note 11.5px `--ink-3`.
- **Blast radius strip**: 22px above, 1px `--rule` top border, 10px padding-top; "Blast radius" 600 + stats
  (`<strong>N</strong> direct dependents · within 3 hops · files · test files · routes`, tabular-nums); bar 6px tall,
  max-width 420px, `--press` track, light fill `--ink-2` = within-3 share, dark fill `--ink` = direct share, both scaled to the
  widest radius in the index; legend 11.5px; `<details>` "What would need re-checking if this changed" listing dependents by file.
- **Members outline** (classes, interfaces, structs, enums, files): rows grid `16px | minmax(160px,auto) | 1fr | auto`,
  padding `6px 4px`, `--rule-faint` separators, name 12.5px mono, signature 11.5px mono `--ink-3` ellipsised,
  counts `← in  → out` 11px mono tabular; nested members indented 22px; properties/enum members dimmed.
- **Keyboard**: `/` or ⌘K search · ↑/↓ (or j/k) move in the active rail · ←/→ switch rail · Enter follow · Backspace or `[` back ·
  `m` map · `f` flow · Esc back to Symbol view. Selection = 1px `--ink` border on the row, scrolled into view.

### 3.3 Trail bar
34px, `--paper-2`, mono 12px. `Trail` label in `--ink-3` sans; hops as buttons (glyph + name, padding 4px 8px) separated by
`→` (stepped into a call) or `←` (stepped up to a caller) in `--ink-3`; current hop: `--accent` text, `--accent-line` border,
`--paper` fill; hover `--press`. Right side: `Read as flow`, `Clear` (sans 4px 8px, `--rule-soft` border). Empty hint in `--ink-3`.

### 3.4 File view (`#/file/<path>`)
Grid **300px | minmax(480px,1fr) | 300px**: Imported by · outline (source order, nested, counts, `line` number right) · Imports.
File rows 12px mono, 5px 14px padding, `--rule-faint` separators; files outside the index in `--ink-3`, not clickable.
Header: file glyph, basename as h1, `lang · KB · N symbols · generated`, full path.

### 3.5 Flow strip (`#/flow/<key>`)
Header: "Flow" + a `<select>` of flows (`--paper-2`, `--rule-soft` border, 12.5px sans) + a 78ch note.
Cards **380px** wide, `--rule-soft` border (`--ink` on hover, `--accent` when current), header grid `16px | 1fr` padding `10px 12px 6px`
(name 600 13px mono, `file:line` 11px `--ink-3`), separator `--rule-faint`, source window `12px/19px` mono with line numbers
(grid `40px | 1fr | 6px`), the call line tinted `--accent-soft` and the calling identifier as an accent link; ±3 lines around the call.
Links between cards: **86px** wide; a 1px `--ink-3` line with a filled arrowhead (polygon `76,3 84,7 76,11` in a 86×14 box);
label 11px mono `--ink-3` centred (`calls`, `line 2029`; `via callback · registered at file:line`); uncertain dasharray `2 3`;
heuristic dasharray `5 3`. End cap: **240px**, dashed `--rule-soft` border, 12px text — "Where the graph stops" + the boundary
(form, key, line) + uncertain continuations. In the real build the strip is a Svelte Flow canvas laid out left→right with the
same card/link visuals.

### 3.6 Map (`#/map`)
Grid: canvas `minmax(600px,1fr)` | side panel **320px** (`--rule-soft` left border, 14px 16px padding).
Nodes: rect `width = max(110, label.length × 7.3 + 28)`, **height 40**, `--paper` fill, 1px `--ink` stroke (2px + `--press` fill
when hovered/selected; `--ink-4` when dimmed; test modules dashed `4 3` in `--ink-3`), label 13px mono at (10,17), count
"N symbols · M files" 11px `--ink-3` at (10,32). Layers: vertical gap **74px**, horizontal gap **34px**, padding 44px; entry points at the
top ("entry points" label), foundations at the bottom ("foundations — depend on nothing below"); faint layer lines `--rule-faint`.
Layout: aggregate edges by module; break 2-cycles keeping the heavier direction; longest-path layering (a module sits one layer
above everything it depends on); barycenter ordering, 3 sweeps; single-node layers centred; ports spread along each box
(`x = left + width × (i+1)/(n+1)` over the node's sorted out/in edges) so bundles fan. Edges: cubic `M x0,y0 C x0,my x1,my x1,y1`
(`my` = midpoint), `stroke-width = min(6, 1 + log2(count) × 0.7)`, `--ink` at opacity 0.28 (hot 0.95, dimmed 0.06); a 12px transparent
hit path per edge; edges with count < 4 (< 6 when tests included) hidden until a touching module is selected; cycle back-edges only when
selected, `--accent` opacity 0.6, dasharray `4 3`. Tooltip: `--paper`, 1px `--ink` border, 8px 10px, 12px: "src/a → src/b", "N edges",
by kind, top 4 symbol pairs. Side panel: title, 2-sentence explanation, hidden-edge note, "Include tests, scripts, kernel & site" checkbox,
"Mutual dependencies" fold, selected module's dependencies/dependents with counts and its files. Fit: SVG width 100%,
`viewBox` to content, `height: max(100%, 0.9 × content)` so labels never scale below ~0.9. In the real build this is a Svelte Flow
canvas (custom node + custom edge components; hidden handles as ports; pan/zoom/fitView) with the same geometry.

### 3.7 Search palette
Results panel under the input: 1px `--ink` border, max-height 420px; group headers 12px `--ink-3` (`Flow`, `Symbols & files`);
rows grid `18px | 1fr | auto`, 6px 10px, `--rule-faint` separators, selected/hover `--press`; name 12.5px mono + signature 11.5px mono
`--ink-3` + location 11px mono. Flow grammar: "how does X reach Y", "X -> Y", "X → Y".

## 4. Libraries and versions
- Svelte 5 (≥ 5.25) + Vite (workspace `ui/`), Svelte Flow `@xyflow/svelte` ^1.6 for the Map and Flow canvases only (custom nodes/edges,
  hidden handles for port spreading, local selection state — the pattern in docker-app's `StackGraph.svelte`); `@dagrejs/dagre` only as a
  fallback if crossing quality demands it (never ELK). Symbol view = DOM + one SVG overlay (`ResizeObserver` re-layout).
- Shiki (JavaScript regex engine, lazy grammars, custom near-monochrome theme as in §2.2) server-side in `/api/source`; tree-sitter-derived
  tokens replace it in phase 3.
- No native modules; no runtime dependency for the UI itself; the CLI serves **`dist/viewer/`** over `node:http`, loopback only.
  (Not `dist/ui/` — `src/ui/` is the engine's *terminal* ui and tsc already compiles it there; see `ui/README.md`.)

## 5. Copy rules
Sentence case; controls say what happens ("Read as flow", "Clear"); counts always visible next to folds; honesty phrases fixed:
"No test reaches this within 3 caller hops", "Reached by tests · N files within 3 hops", "Uncertain · N name-only matches, confidence < 0.6",
"outside the index", "Where the graph stops", "changed on disk after the last index sync".

---

## Appendix — prototype stylesheet (verbatim; measurements above are derived from it)

```css
/* ---------- tokens: paper/ink editorial, one oxblood accent ---------- */
:root {
  --paper: #f7f6f2; --paper-2: #f1efe8; --press: #e8e6dd; --press-2: #dedbd0;
  --ink: #16150f; --ink-2: #56544a; --ink-3: #87847a; --ink-4: #b4b1a5;
  --rule: #16150f; --rule-soft: #d6d3c8; --rule-faint: #e6e3d9;
  --accent: #7a2230; --accent-ink: #5e1a25; --accent-soft: #f0e3e5; --accent-line: #d9b3b9;
  --amber: #8a5a0b; --amber-soft: #f3e9d2;
  --sans: 'Archivo', -apple-system, BlinkMacSystemFont, 'Helvetica Neue', Arial, sans-serif;
  --mono: 'IBM Plex Mono', ui-monospace, 'SF Mono', Menlo, Consolas, monospace;
  --code-size: 12.5px; --code-lh: 20px;
}
@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) {
    --paper: #16150f; --paper-2: #1c1a14; --press: #23211a; --press-2: #2c2a22;
    --ink: #f3f1ea; --ink-2: #b8b5a8; --ink-3: #87847a; --ink-4: #5d5b52;
    --rule: #f3f1ea; --rule-soft: #34322a; --rule-faint: #26241d;
    --accent: #d48b96; --accent-ink: #e5a5ae; --accent-soft: #33201f; --accent-line: #6b3a42;
    --amber: #d9a94a; --amber-soft: #2e2716;
  }
}
:root[data-theme="dark"] {
  --paper: #16150f; --paper-2: #1c1a14; --press: #23211a; --press-2: #2c2a22;
  --ink: #f3f1ea; --ink-2: #b8b5a8; --ink-3: #87847a; --ink-4: #5d5b52;
  --rule: #f3f1ea; --rule-soft: #34322a; --rule-faint: #26241d;
  --accent: #d48b96; --accent-ink: #e5a5ae; --accent-soft: #33201f; --accent-line: #6b3a42;
  --amber: #d9a94a; --amber-soft: #2e2716;
}

html, body { height: 100%; }
body { margin: 0; background: var(--paper); color: var(--ink); font-family: var(--sans); font-size: 13px; line-height: 1.45; -webkit-font-smoothing: antialiased; }
* { box-sizing: border-box; border-radius: 0 !important; }
a { color: inherit; text-decoration: none; }
button { font: inherit; color: inherit; background: none; border: 0; padding: 0; cursor: pointer; }
.mono { font-family: var(--mono); }
.dim { color: var(--ink-3); }
.hidden { display: none !important; }
:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
@media (prefers-reduced-motion: reduce) { * { transition: none !important; animation: none !important; } }

#app { height: 100vh; display: grid; grid-template-rows: 48px 34px 1fr; }

/* ---------- top bar ---------- */
.topbar { display: grid; grid-template-columns: auto auto 1fr auto; align-items: center; gap: 22px; padding: 0 18px; border-bottom: 1px solid var(--rule); background: var(--paper); position: relative; z-index: 30; }
.brand { display: flex; align-items: baseline; gap: 8px; }
.brand-mark { display: inline-block; width: 10px; height: 10px; border: 1.5px solid var(--ink); background: var(--paper); align-self: center; }
.brand-name { font-weight: 600; letter-spacing: -0.01em; font-size: 14px; }
.brand-sub { color: var(--ink-3); font-size: 12px; }
.views { display: flex; gap: 2px; }
.views a { padding: 5px 10px; color: var(--ink-2); border-bottom: 2px solid transparent; }
.views a:hover { color: var(--ink); }
.views a.active { color: var(--ink); border-bottom-color: var(--ink); }
.search { position: relative; max-width: 720px; }
#q { width: 100%; height: 30px; padding: 0 10px; border: 1px solid var(--rule-soft); background: var(--paper-2); color: var(--ink); font: 13px var(--sans); }
#q:focus { border-color: var(--ink); outline: none; }
#q::placeholder { color: var(--ink-3); }
.q-results { position: absolute; top: 32px; left: 0; right: 0; background: var(--paper); border: 1px solid var(--ink); max-height: 420px; overflow: auto; z-index: 40; }
.q-row { display: grid; grid-template-columns: 18px 1fr auto; gap: 10px; align-items: baseline; padding: 6px 10px; border-bottom: 1px solid var(--rule-faint); cursor: pointer; }
.q-row:last-child { border-bottom: 0; }
.q-row:hover, .q-row.sel { background: var(--press); }
.q-row .nm { font-family: var(--mono); font-size: 12.5px; }
.q-row .sig { color: var(--ink-3); font-family: var(--mono); font-size: 11.5px; margin-left: 6px; }
.q-row .loc { color: var(--ink-3); font-family: var(--mono); font-size: 11px; white-space: nowrap; }
.q-head { padding: 6px 10px 4px; color: var(--ink-3); font-size: 12px; border-bottom: 1px solid var(--rule-faint); }
.project { color: var(--ink-2); font-size: 12px; white-space: nowrap; }

/* kind glyph: hollow square variants, mono letter */
.k { display: inline-flex; width: 16px; height: 16px; align-items: center; justify-content: center; border: 1px solid var(--ink-3); color: var(--ink-2); font: 500 9.5px var(--mono); flex: 0 0 auto; }
.k.fn { border-style: solid; }
.k.cls, .k.iface, .k.struct, .k.type { background: var(--press); }
.k.file { border-style: dashed; }

/* ---------- trail bar ---------- */
.trailbar { display: flex; align-items: center; gap: 0; padding: 0 18px; border-bottom: 1px solid var(--rule-soft); background: var(--paper-2); overflow-x: auto; white-space: nowrap; font-family: var(--mono); font-size: 12px; }
.trailbar .label { color: var(--ink-3); font-family: var(--sans); margin-right: 10px; }
.hop { display: inline-flex; align-items: center; gap: 6px; padding: 4px 8px; color: var(--ink-2); border: 1px solid transparent; }
.hop:hover { color: var(--ink); background: var(--press); }
.hop.cur { color: var(--accent); border-color: var(--accent-line); background: var(--paper); }
.hop-arrow { color: var(--ink-3); padding: 0 2px; }
.hop-arrow.up { color: var(--ink-2); }
.trailbar .spacer { flex: 1; }
.trailbar .tb-btn { font-family: var(--sans); color: var(--ink-2); padding: 4px 8px; border: 1px solid var(--rule-soft); margin-left: 8px; background: var(--paper); }
.trailbar .tb-btn:hover { border-color: var(--ink); color: var(--ink); }
.trailbar .empty { color: var(--ink-3); font-family: var(--sans); }

/* ---------- main / focus layout ---------- */
#main { min-height: 0; overflow: hidden; }
.focus { display: grid; grid-template-columns: 300px minmax(520px, 1fr); height: 100%; min-height: 0; }
.rail-left { border-right: 1px solid var(--rule-soft); overflow: auto; background: var(--paper); }
.stage { position: relative; overflow: auto; }
.stage-inner { position: relative; display: grid; grid-template-columns: minmax(480px, 1fr) 320px; min-height: 100%; }
.center { padding: 18px 22px 40px 22px; min-width: 0; }
.rail-right { position: relative; border-left: 1px solid var(--rule-faint); }
.overlay { position: absolute; inset: 0; pointer-events: none; overflow: visible; }
.overlay path { fill: none; stroke: var(--ink-4); stroke-width: 1; }
.overlay path.hot { stroke: var(--accent); stroke-width: 1.5; }
.overlay path.uncertain { stroke-dasharray: 2 3; }
.overlay path.heur { stroke-dasharray: 6 3; stroke: var(--ink-3); }
.overlay path.origin { stroke: var(--accent); }

/* rail headings */
.rail-h { display: flex; align-items: baseline; justify-content: space-between; padding: 12px 14px 8px; font-weight: 600; font-size: 13px; border-bottom: 1px solid var(--rule-soft); position: sticky; top: 0; background: var(--paper); z-index: 2; }
.rail-h .n { color: var(--ink-3); font-weight: 400; }
.rail-h .hint { color: var(--ink-3); font-weight: 400; font-size: 11.5px; }
.filegroup { padding: 10px 14px 4px; }
.filegroup .fpath { font: 11px var(--mono); color: var(--ink-3); margin-bottom: 4px; display: flex; justify-content: space-between; gap: 8px; }
.filegroup .fpath b { color: var(--ink-2); font-weight: 500; }
.filegroup .fpath a:hover { color: var(--ink); text-decoration: underline; }
.row { display: grid; grid-template-columns: 16px 1fr; gap: 8px; align-items: start; padding: 5px 6px 5px 4px; margin: 0 -6px; cursor: pointer; border: 1px solid transparent; position: relative; }
.row:hover { background: var(--press); }
.row.sel { border-color: var(--ink); }
.row.origin { background: var(--accent-soft); border-color: var(--accent-line); }
.row .nm { font: 12.5px var(--mono); color: var(--ink); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.row .meta { color: var(--ink-3); font-size: 11px; margin-top: 1px; display: flex; flex-wrap: wrap; gap: 4px 8px; align-items: baseline; }
.row .kindlbl { color: var(--ink-3); }
.row .chip { font: 11px var(--mono); color: var(--ink-2); border: 1px solid var(--rule-soft); padding: 0 4px; background: var(--paper); }
.row .chip:hover { border-color: var(--ink); color: var(--ink); }
.row.uncertain .nm, .row.stub .nm { color: var(--ink-2); }
.row.uncertain .nm { text-decoration: underline dotted var(--ink-4); text-underline-offset: 3px; }
.row.stub { cursor: default; }
.row.stub .nm::after { content: ' ·'; color: var(--ink-4); }
.fold { padding: 8px 14px; }
.fold > summary { cursor: pointer; color: var(--ink-2); font-size: 12px; list-style: none; display: flex; gap: 6px; align-items: baseline; }
.fold > summary::before { content: '+'; font-family: var(--mono); color: var(--ink-3); width: 10px; }
.fold[open] > summary::before { content: '−'; }
.fold .body { padding: 6px 0 0 16px; color: var(--ink-2); font-size: 12px; }
.fold .body .fp { font: 11px var(--mono); color: var(--ink-2); padding: 2px 0; }
.note { padding: 8px 14px; color: var(--ink-3); font-size: 11.5px; line-height: 1.4; }

/* ---------- focus card ---------- */
.card-h { display: flex; flex-wrap: wrap; align-items: baseline; gap: 6px 12px; }
.card-h h1 { margin: 0; font: 600 20px/1.2 var(--mono); letter-spacing: -0.01em; }
.card-h .kindword { color: var(--ink-3); font-size: 12.5px; }
.card-h .loc { font: 11.5px var(--mono); color: var(--ink-2); }
.card-h .loc a:hover { text-decoration: underline; }
.badges { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 10px; }
.badge { font-size: 11.5px; color: var(--ink-2); border: 1px solid var(--rule-soft); padding: 2px 7px; background: var(--paper); display: inline-flex; gap: 5px; align-items: center; }
.badge.ok { border-color: var(--rule-soft); }
.badge.warn { color: var(--amber); border-color: var(--amber); background: var(--amber-soft); }
.badge.hub { border-color: var(--ink); }
.badge .sw { width: 8px; height: 8px; border: 1px solid currentColor; display: inline-block; }
.badge.warn .sw { background: currentColor; }
.sig { margin-top: 10px; font: 12px var(--mono); color: var(--ink-2); white-space: pre-wrap; word-break: break-word; }
.doc { margin-top: 8px; color: var(--ink-2); font-size: 12.5px; max-width: 70ch; white-space: pre-wrap; }
.parents { margin-top: 6px; font: 11.5px var(--mono); color: var(--ink-3); }
.parents a:hover { color: var(--ink); text-decoration: underline; }
.rel { margin-top: 10px; display: flex; flex-wrap: wrap; gap: 6px; align-items: baseline; font-size: 12px; color: var(--ink-3); }
.rel .chip { font: 11.5px var(--mono); color: var(--ink-2); border: 1px solid var(--rule-soft); padding: 1px 6px; cursor: pointer; background: var(--paper); }
.rel .chip:hover { border-color: var(--ink); color: var(--ink); }

/* code */
.code { margin-top: 16px; border-top: 1px solid var(--rule); padding-top: 6px; font: var(--code-size)/var(--code-lh) var(--mono); }
.ln { display: grid; grid-template-columns: 44px 1fr 18px; align-items: stretch; position: relative; }
.ln:hover { background: var(--paper-2); }
.ln.hot { background: var(--accent-soft); }
.ln .no { color: var(--ink-4); text-align: right; padding-right: 12px; user-select: none; font-size: 11px; }
.ln .tx { white-space: pre; overflow-x: auto; scrollbar-width: none; }
.ln .tx::-webkit-scrollbar { display: none; }
.ln .port { position: relative; }
.ln .port i { position: absolute; right: 4px; top: 7px; width: 6px; height: 6px; border: 1px solid var(--ink-3); background: var(--paper); }
.ln .port i.sure { background: var(--ink-3); }
.ln.hot .port i { border-color: var(--accent); background: var(--accent); }
.gap { color: var(--ink-4); padding: 2px 0 2px 44px; font-size: 11px; border-top: 1px dashed var(--rule-soft); border-bottom: 1px dashed var(--rule-soft); margin: 2px 0; }
.t-c { color: var(--ink-3); }
.t-s { color: var(--ink-2); }
.t-k { font-weight: 500; }
.t-n { color: var(--ink-2); }
.t-def { font-weight: 600; }
.ref { color: var(--accent); cursor: pointer; text-decoration: underline; text-decoration-color: var(--accent-line); text-underline-offset: 3px; }
.ref:hover, .ref.hot { text-decoration-color: var(--accent); background: var(--accent-soft); }
.ref.uncertain { color: var(--ink-2); text-decoration-style: dotted; text-decoration-color: var(--ink-4); }
.ref.stub { color: var(--ink-2); text-decoration-color: var(--rule-soft); cursor: default; }

/* callee rail rows (absolutely positioned to lines) */
.rail-right .rrow { position: absolute; left: 14px; right: 12px; height: 34px; display: grid; grid-template-columns: 16px 1fr; gap: 8px; align-items: center; padding: 0 6px; border: 1px solid transparent; cursor: pointer; }
.rail-right .rrow:hover { background: var(--press); }
.rail-right .rrow.sel { border-color: var(--ink); }
.rail-right .rrow.hot { background: var(--accent-soft); border-color: var(--accent-line); }
.rail-right .rrow.origin { background: var(--accent-soft); }
.rail-right .rrow .nm { font: 12.5px var(--mono); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.rail-right .rrow .meta { font-size: 11px; color: var(--ink-3); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; display: flex; gap: 8px; }
.rail-right .rrow.uncertain .nm { color: var(--ink-2); text-decoration: underline dotted var(--ink-4); text-underline-offset: 3px; }
.rail-right .rrow.stub { cursor: default; }
.rail-right .rrow.stub .nm { color: var(--ink-2); }
.rail-right .rrow .tag { font-size: 10.5px; color: var(--ink-3); border: 1px solid var(--rule-soft); padding: 0 4px; }
.rail-right .rfold { position: absolute; left: 14px; right: 12px; }
.rail-right .rfold summary { cursor: pointer; color: var(--ink-2); font-size: 12px; list-style: none; padding: 6px; }
.rail-right .rfold summary::before { content: '+ '; font-family: var(--mono); color: var(--ink-3); }
.rail-right .rfold[open] summary::before { content: '− '; }
.rail-right .rfold .body .rrow { position: static; height: auto; padding: 4px 6px; }
.rail-right .rnote { position: absolute; left: 20px; right: 12px; color: var(--ink-3); font-size: 11.5px; line-height: 1.4; }
.rail-right .rail-h { position: sticky; }

/* blast radius */
.blast { margin-top: 22px; border-top: 1px solid var(--rule); padding-top: 10px; }
.blast .bh { display: flex; flex-wrap: wrap; align-items: baseline; gap: 6px 14px; }
.blast .bh b { font-weight: 600; }
.blast .stat { font-size: 12.5px; color: var(--ink-2); }
.blast .stat strong { color: var(--ink); font-weight: 600; font-variant-numeric: tabular-nums; }
.blast .bar { height: 6px; background: var(--press); margin-top: 8px; position: relative; max-width: 420px; }
.blast .bar i { position: absolute; left: 0; top: 0; bottom: 0; background: var(--ink-2); }
.blast .bar i.direct { background: var(--ink); }
.blast .legend { color: var(--ink-3); font-size: 11.5px; margin-top: 4px; }
.blast details { margin-top: 8px; }
.blast summary { cursor: pointer; color: var(--ink-2); font-size: 12px; list-style: none; }
.blast summary::before { content: '+ '; font-family: var(--mono); color: var(--ink-3); }
.blast details[open] summary::before { content: '− '; }

/* members outline (class / interface / file) */
.outline { margin-top: 14px; border-top: 1px solid var(--rule); }
.orow { display: grid; grid-template-columns: 16px minmax(160px, auto) 1fr auto; gap: 10px; align-items: baseline; padding: 6px 4px; border-bottom: 1px solid var(--rule-faint); cursor: pointer; }
.orow:hover { background: var(--press); }
.orow .nm { font: 12.5px var(--mono); }
.orow .sig { font: 11.5px var(--mono); color: var(--ink-3); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.orow .cnt { font: 11px var(--mono); color: var(--ink-3); white-space: nowrap; font-variant-numeric: tabular-nums; }
.orow.nested { padding-left: 22px; }
.orow.dimmed .nm { color: var(--ink-3); }
.subh { margin: 18px 0 4px; font-weight: 600; font-size: 13px; display: flex; gap: 8px; align-items: baseline; }
.subh .n { color: var(--ink-3); font-weight: 400; }

/* ---------- file view ---------- */
.fileview { display: grid; grid-template-columns: 300px minmax(480px, 1fr) 300px; height: 100%; }
.fileview .rail-left, .fileview .rail-r2 { overflow: auto; }
.fileview .rail-r2 { border-left: 1px solid var(--rule-soft); }
.fileview .center { overflow: auto; }
.filerow { display: block; padding: 5px 14px; font: 12px var(--mono); color: var(--ink-2); cursor: pointer; border-bottom: 1px solid var(--rule-faint); }
.filerow:hover { background: var(--press); color: var(--ink); }
.filerow.stubf { color: var(--ink-3); cursor: default; }

/* ---------- flow view ---------- */
.flow { height: 100%; overflow: auto; padding: 18px 22px; }
.flow-h { display: flex; flex-wrap: wrap; align-items: baseline; gap: 10px 18px; margin-bottom: 14px; }
.flow-h h2 { margin: 0; font-size: 16px; font-weight: 600; }
.flow-h select { font: 12.5px var(--sans); border: 1px solid var(--rule-soft); background: var(--paper-2); color: var(--ink); padding: 4px 8px; }
.strip { display: flex; align-items: flex-start; gap: 0; overflow-x: auto; padding-bottom: 18px; }
.hopcard { flex: 0 0 380px; border: 1px solid var(--rule-soft); background: var(--paper); cursor: pointer; }
.hopcard:hover { border-color: var(--ink); }
.hopcard.cur { border-color: var(--accent); }
.hopcard .hh { padding: 10px 12px 6px; border-bottom: 1px solid var(--rule-faint); display: grid; grid-template-columns: 16px 1fr; gap: 8px; align-items: start; }
.hopcard .hh .nm { font: 600 13px var(--mono); }
.hopcard .hh .loc { font: 11px var(--mono); color: var(--ink-3); }
.hopcard .hh .stepno { color: var(--ink-3); font-size: 11px; font-family: var(--mono); }
.hopcard .win { padding: 6px 0 8px; font: 12px/19px var(--mono); }
.hopcard .win .ln { grid-template-columns: 40px 1fr 6px; }
.hopcard .win .ln .no { font-size: 10.5px; }
.hopcard .win .ln .tx { white-space: pre; overflow: hidden; text-overflow: ellipsis; }
.hopcard .nosrc { padding: 10px 12px; color: var(--ink-3); font-size: 12px; }
.hoplink { flex: 0 0 86px; display: flex; flex-direction: column; align-items: center; padding-top: 14px; color: var(--ink-3); font: 11px var(--mono); text-align: center; gap: 4px; }
.hoplink svg { width: 86px; height: 14px; display: block; }
.hoplink svg line { stroke: var(--ink-3); stroke-width: 1; }
.hoplink svg polygon { fill: var(--ink-3); }
.hoplink.uncertain svg line { stroke-dasharray: 2 3; }
.hoplink.heur svg line { stroke-dasharray: 5 3; }
.hoplink .lbl { max-width: 84px; line-height: 1.3; }
.endcap { flex: 0 0 240px; border: 1px dashed var(--rule-soft); padding: 12px; color: var(--ink-2); font-size: 12px; line-height: 1.45; align-self: stretch; }
.endcap b { color: var(--ink); font-weight: 600; }
.flow-note { color: var(--ink-3); font-size: 12px; max-width: 78ch; line-height: 1.5; }

/* ---------- map view ---------- */
.mapview { display: grid; grid-template-columns: minmax(600px, 1fr) 320px; height: 100%; }
.mapstage { position: relative; overflow: auto; }
.mapstage svg { display: block; width: 100%; }
.mapside details { margin: 4px 0 10px; }
.mapside summary::-webkit-details-marker { display: none; }
.mapside { border-left: 1px solid var(--rule-soft); overflow: auto; padding: 14px 16px; }
.mapside h2 { margin: 0 0 6px; font-size: 15px; font-weight: 600; }
.mapside p { margin: 0 0 10px; color: var(--ink-2); font-size: 12.5px; line-height: 1.5; max-width: 40ch; }
.mapside .toggle { display: flex; gap: 8px; align-items: center; font-size: 12.5px; color: var(--ink-2); margin: 10px 0 14px; cursor: pointer; }
.mapside .toggle input { margin: 0; accent-color: var(--ink); }
.mapside .cyc { font: 11.5px var(--mono); color: var(--ink-2); padding: 3px 0; }
.mapside .cyc b { color: var(--accent); font-weight: 500; }
.mapside .modlist { margin-top: 8px; }
.mapside .edgeinfo { margin-top: 12px; border-top: 1px solid var(--rule-soft); padding-top: 10px; }
.mapside .edgeinfo .pair { font: 11.5px var(--mono); color: var(--ink-2); padding: 2px 0; display: flex; justify-content: space-between; gap: 10px; }
.mapside .edgeinfo .pair b { color: var(--ink); font-weight: 500; }
.mnode rect { fill: var(--paper); stroke: var(--ink); stroke-width: 1; }
.mnode text { font: 13px var(--mono); fill: var(--ink); }
.mnode .cnt { font-size: 11px; fill: var(--ink-3); }
.mnode.test rect { stroke-dasharray: 4 3; stroke: var(--ink-3); }
.mnode.test text { fill: var(--ink-2); }
.mnode:hover rect, .mnode.sel rect { stroke-width: 2; fill: var(--press); }
.mnode.dimmed rect { stroke: var(--ink-4); }
.mnode.dimmed text { fill: var(--ink-4); }
.medge { fill: none; stroke: var(--ink); stroke-opacity: 0.28; cursor: pointer; }
.medge:hover, .medge.hot { stroke-opacity: 0.95; }
.medge.dimmed { stroke-opacity: 0.06; }
.medge.cycle { stroke: var(--accent); stroke-opacity: 0.6; }
.medge-hit { fill: none; stroke: transparent; stroke-width: 12; cursor: pointer; }
.layerlbl { font: 12px var(--sans); fill: var(--ink-3); }
.layerline { stroke: var(--rule-faint); stroke-width: 1; }
.tip { position: absolute; z-index: 20; background: var(--paper); border: 1px solid var(--ink); padding: 8px 10px; font-size: 12px; color: var(--ink); pointer-events: none; max-width: 320px; }
.tip .mono { font-size: 11.5px; }
.tip .row2 { display: flex; justify-content: space-between; gap: 12px; color: var(--ink-2); }

/* ---------- misc ---------- */
.toast { position: fixed; left: 50%; bottom: 22px; transform: translateX(-50%); background: var(--ink); color: var(--paper); padding: 8px 14px; font-size: 12.5px; z-index: 50; max-width: 70ch; }
.kbd { font: 11px var(--mono); border: 1px solid var(--rule-soft); padding: 0 4px; color: var(--ink-2); background: var(--paper); }
.emptystate { padding: 40px; color: var(--ink-2); max-width: 60ch; line-height: 1.5; }
.emptystate h2 { margin: 0 0 8px; font-size: 16px; }
@media (max-width: 1100px) { .focus { grid-template-columns: 240px 1fr; } .stage-inner { grid-template-columns: minmax(360px, 1fr) 260px; } .fileview { grid-template-columns: 220px 1fr 220px; } .mapview { grid-template-columns: 1fr 260px; } }
```
