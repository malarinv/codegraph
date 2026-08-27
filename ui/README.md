# ui/ — the `codegraph ui` viewer

The browser reader for an indexed project: Svelte 5 + Vite, built as static
files and served by the CLI over loopback. An npm workspace of the engine, so
`npm ci` at the repo root installs its toolchain; nothing here is a runtime
dependency of the engine and nothing here is published to npm on its own.

Design spec (every token, size and measurement):
`../docs/design/codegraph-ui-design-spec.md`.

## Build

```bash
npm run build          # from the repo root: tsc -> copy-assets -> this app
npm run build:ui       # just this app, plus the dist assertion
npm run dev -w ui      # Vite dev server on 127.0.0.1:5174
npm run check -w ui    # svelte-check
```

`npm run build` emits **`dist/viewer/`** (`index.html` + hashed assets).
`scripts/check-ui-build.mjs` then asserts the tree is complete, so a broken UI
build fails the release instead of shipping a CLI that serves a 404. The same
check runs again in `scripts/build-bundle.sh` (after the bundle stage copies
`dist`) and in `scripts/pack-npm.sh` (after each archive is unpacked).

### Why `dist/viewer` and not `dist/ui`

`src/ui/` is the engine's **terminal** UI (shimmer progress and its worker) and
tsc compiles it to `dist/ui/`. Pointing Vite there deletes those modules — the
CLI then dies at startup with `Cannot find module '../ui/shimmer-progress'` —
and would also leave the static server handing out compiled engine internals.
`check-ui-build.mjs` re-asserts the compiled engine is intact after every UI
build so that mistake cannot land twice.

## Layout

```
src/
  main.ts                 fonts + tokens, mounts App into index.html's #app
  app.css                 design tokens (light/dark), reset, shell grid
  App.svelte              top bar / trail bar / main, global keys
  lib/router.svelte.ts    hash router: #/s/<id>, #/file/<path>, #/map, #/flow, #/entry
  lib/trail.svelte.ts     the walked path; mirrored into the `t` query param
  lib/kinds.ts            kind glyph letters
  lib/map-model.ts        the Map's deterministic layered layout (pure)
  lib/flow-model.ts       the Flow strip's card/link geometry + the end cap — a DAG (pure)
  lib/filecode-model.ts   the whole-file view: fixed line height, arcs, paging (pure)
  lib/entry-model.ts      the entry-points panel: rows, file groups, flow arming (pure)
  lib/live.svelte.ts      /api/events: two counters every screen refreshes from
  lib/toast.svelte.ts     the one transient note ("Index updated · reloaded")
  components/             TopBar, TrailBar, KindGlyph, DriftBanner, Toast, map/, flow/, symbol/, file/, entry/
  views/                  one component per route
```

Fonts (Archivo Variable, IBM Plex Mono) are vendored through `@fontsource*` and
emitted into `dist/viewer/assets`: a local reader must work offline and must not
announce the project to a font CDN.

## Routes

| hash | view |
|---|---|
| `#/` | nothing selected |
| `#/s/<id>?hl=<line>&t=<trail>` | symbol view |
| `#/file/<path>?hl=<line>` | file view — outline in source order |
| `#/file/<path>?src=1` | file view — the whole file's source, with ports and call arcs |
| `#/map?root=&depth=&tests=1` | module map |
| `#/flow?from=&to=` | flow strip — the call path between two symbols |
| `#/flow?symbols=a,b,c` | flow strip — `codegraph_explore`'s own question |
| `#/flow?t=<trail>` | flow strip — the trail you walked, read as a flow |
| `#/entry` | entry points — routes, files that run something, tests, hubs |

## Entry points

`#/entry` draws `/api/entrypoints` as file groups, reusing the Symbol view's
`.filegroup` / `.row` shapes rather than inventing a second visual language for
"a list of code, grouped by where it lives". Three things about it are decisions,
not accidents:

- **Routes group by where the URL is REGISTERED, not where it is served.** A
  router file is the shape a reader already has in mind; handlers scatter across
  a package. The payload carries both, and the row's meta line names the handler
  and its `file:line`.
- **A row offers a flow only if it names a callable symbol.** `/api/flow`
  searches the graph by NAME, and a file has none the path finder can look up —
  so route and hub rows carry a `Flow ›` chip and file and test rows do not. A
  chip that always failed would be worse than no chip.
- **No empty Routes box.** A project with fewer than three resolvable routes is
  not a routed app, and the section is absent rather than empty; the panel falls
  back to the files that run something and the tests that exercise them.

`buildEntryPanel` is pure and keeps `panel.rows` exactly equal to the sections it
draws, the same identity the search palette rests its keyboard on.

## Where the graph stops

A flow that does not reach everything it was asked about carries a
`boundary` on the wire, and `buildFlowLayout` turns it into an extra 240px node
one column past the symbol the path stopped at, joined by a dotted `2 4` link
labelled "end of static path" that deliberately has **no arrowhead** — an arrow
would point at a continuation, and the absence of one is the finding.

Two rules hold it together:

- **The cap's height is arithmetic, like a card's.** `endCapText()` builds every
  sentence the cap shows and `endCapHeight()` measures them; the component then
  renders exactly what was measured. Change the wording in one and the other
  moves with it — they are the same function read twice.
- **One cap per stopping symbol, not per flow.** Two paths that run out at the
  same place ran out for the same reason, and two caps side by side would read
  as two different findings.

The verdict itself is not computed here or in the server: it is
`findDynamicBoundaries` in `src/graph/dynamic-boundary-report.ts`, the same
detector `codegraph_explore` announces boundaries with.

## Live updates

The viewer never polls. `lib/live.svelte.ts` holds one `EventSource` on
`/api/events` for the life of the page and exposes two counters:

- **`indexTick`** — the graph moved (somebody synced). Every screen refetches:
  a rail is an answer about the whole graph, and a symbol gains a caller when
  some *other* file is edited, so filtering by the focused file would leave the
  rails quietly wrong. One request per sync.
- **`diskTick`** — source files changed on disk and the index has not caught up.
  Only the screen showing one of those files reacts, and what it does is draw a
  drift banner.

`liveRefresh(file, refresh)` is the three lines of bookkeeping that turns a
counter into a single call; the Map and the Flow strip instead read
`live.indexTick` straight inside the effect that already fetches them.

Reconnection is ours, not `EventSource`'s: each failure closes the stream and
schedules ONE retry on a backoff that ends after eight attempts (~90 s), at
which point the top bar says "Not live" and nothing more is requested until the
tab is focused again. A `degraded` event — the server's watcher gave up — is
shown the same way and never answered with a poll.

Node ids and file paths are encoded per slash-separated segment, so
`#/file/src/mcp/tools.ts` stays readable and still round-trips a segment
containing a reserved character. Build hashes with `symbolHref()` /
`fileHref()` / `mapHref()` / `flowHref()` rather than by hand.
