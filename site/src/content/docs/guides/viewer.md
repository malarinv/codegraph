---
title: Reading Your Graph in the Browser
description: codegraph ui opens a local viewer for an indexed project — callers, source, and callees on one screen.
---

`codegraph ui` opens a viewer for a project you have already indexed. It is the same graph your agent reads, on screen.

```bash
codegraph init          # once per project, if you haven't already
codegraph ui            # opens http://127.0.0.1:4747 in your browser
```

![The CodeGraph viewer: callers on the left, the symbol's source in the middle with a marker on every calling line, and the symbols it calls on the right, each level with its call site](https://raw.githubusercontent.com/colbymchenry/codegraph/main/assets/codegraph-ui-symbol-view.png?v=1)

## The symbol screen

Pick a symbol and you get three columns that all describe the same thing:

- **Called by**, on the left, grouped by file, each caller carrying the exact line it calls from. Click a line number to open that caller scrolled to the call. Test callers fold into a single line so real callers stay in view.
- **The source**, in the middle, verbatim from disk and syntax-highlighted, with a marker in the gutter on every line that calls something and a link on every call CodeGraph resolved. A long body shows its opening plus a window around every call site, with the skipped runs counted rather than hidden.
- **Calls**, on the right, one row per symbol this one calls, drawn level with the line that calls it and joined to that line by a hairline. Hover either end and the line, the gutter marker and the connector all light up. A symbol called from several lines says so; `creates` marks a constructor.

A class, interface, struct or enum shows its members in source order instead of a body, each with how many things call it and how many things it calls.

Under the source, a **blast radius** strip counts what a change here would reach: direct dependents, everything within three hops, and how many files, test files and routes that touches.

## Honesty on screen

The viewer never presents a guess as a fact:

- Edges CodeGraph resolved by name alone, below its confidence threshold, fold into an "uncertain" line rather than sitting among the resolved ones. Nothing is silently dropped — the count is always there.
- A symbol that no test reaches within three caller hops wears a badge saying exactly that.
- Calls into symbols that aren't in the index are counted and marked, not omitted.
- A file that changed on disk since it was indexed shows a banner instead of source that may no longer line up.

## Getting around

- **Search** with `/` or Cmd-K: every symbol and file, grouped by kind, with signature and `file:line`. Arrow keys and Enter, no mouse needed.
- **Entry points** on the opening screen: your framework's routes, the files that run code when they're imported, and the most depended-on symbols in the project.
- **A trail** records the path you walked, with an arrow per hop showing whether you stepped into a call or up to a caller. Click any hop to jump back to it. The trail lives in the URL, so you can send someone the exact route you took.
- **Keyboard:** arrow keys move within a column, left/right switch columns, Enter follows, Backspace steps back.

Clicking any file path opens the **file view**: everything that file depends on, its outline in source order, and everything that depends on it.

## Options

| | |
|---|---|
| `codegraph ui [path]` | Read a specific indexed project instead of the current directory |
| `--port <n>` | Pin a port. Without it the viewer takes 4747, or the next free one |
| `--no-open` | Print the URL instead of opening a browser (headless boxes, SSH) |
| `CODEGRAPH_BROWSER=<command>` | Choose which browser opens. `CODEGRAPH_BROWSER=none` never opens one |

`codegraph web` is an alias for the same command.

## Privacy

The viewer listens on `127.0.0.1` only, so nothing on your network can reach it, and requests claiming to come from any other host are refused. It is read-only: it opens an index that already exists, never creates one, and never writes to your project or your graph.

It sends nothing anywhere — no code, no paths, no analytics. The page in your browser talks only to the server on your own machine, and that server makes no outbound connections at all. See [Telemetry](https://github.com/colbymchenry/codegraph/blob/main/TELEMETRY.md) for the complete picture.

The viewer reads an index that already exists, so run [`codegraph init`](/codegraph/guides/indexing/) in the project first.
