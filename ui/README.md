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
  lib/router.svelte.ts    hash router: #/s/<id>, #/file/<path>, #/map, #/flow
  lib/trail.svelte.ts     the walked path; mirrored into the `t` query param
  lib/kinds.ts            kind glyph letters
  lib/map-model.ts        the Map's deterministic layered layout (pure)
  components/             TopBar, TrailBar, KindGlyph, map/, symbol/, file/
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
| `#/file/<path>?hl=<line>` | file view |
| `#/map?root=&depth=&tests=1` | module map |
| `#/flow[/<key>]` | flow strip — reserved, phase 2 |

Node ids and file paths are encoded per slash-separated segment, so
`#/file/src/mcp/tools.ts` stays readable and still round-trips a segment
containing a reserved character. Build hashes with `symbolHref()` /
`fileHref()` rather than by hand.
