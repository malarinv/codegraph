# Release-to-main correctness repairs (September 2026)

Compared the installed `@colbymchenry/codegraph@1.6.0` npm bundle (release
`dfccdf62547fcd76d343344d823a0e1998d3a89f`) with main
`3ed73bc127323e63153bf6ec8354afa82ce36aaf`. Both ran with the bundle's Node
24.16.0 on Linux x64, identical fixture revisions/settings and separate
indexes. Native and forced-WASM probes were kept separate. Main was fetched
again before this change; the comparison base had not advanced.

## Confirmed losses and repairs

| Loss | Introducing change | Repair |
|---|---|---|
| Typed TSX-to-TS field calls, including Excalidraw's observer registration and mutation-to-render flow | `cece072` (#1792) | Use the same JS/TS language family in cached and uncached method lookup. |
| Destructured Zustand actions lose their callers | `cd4e65b` (#1759) | Trace the actual state binding before rejecting locally bound names. |
| Adding interface signatures makes store accessor calls ambiguous | `ee83636` (#1780) | Find the implementation inside the identified store, not a globally unique name. |
| Direct React Native bridge calls disappear | `de5adba` (#1790) | Retain qualified call sites and let the framework validate the module. |
| Dart extension-type getters disappear in WASM | `ee83636` (#1780) | Apply the bodyless-signature guard only to its intended JS/TS grammars. |

Each introducing commit was checked against its parent with the same minimal
fixture. The lost relationships were checked against source wiring rather
than inferred from edge-count differences. The Excalidraw path is
`Scene.mutateElement → Scene.triggerUpdate → App.triggerRender → App.render
→ StaticCanvas → renderStaticScene`.

## Remaining suite failures

The nine failing Steps assertions had two causes: external member-chain call
sites had been discarded before effect classification, and valid Zustand
selector bindings were blocked as opaque local calls. Qualified external
references now survive without becoming guessed internal call edges. Store
selectors require a Zustand factory import, resolve the selected member in
that store, and respect lexical scope and shadowing. Renamed selections and
closure captures are covered, including negative cases for unrelated
factories, stores, parameters, and local declarations.

The tenth failure was a stale callers-truncation fixture: it counted a filename
as an overload of its exact-named function. The fixture now contains two real
functions and checks that **both** truncated sections carry their markers.
The extraction parity expectations now assert the exact retained qualified
references and all argument calls. No assertion was removed or replaced by a
skip.

## Validation

- All ten formerly failing assertions pass on native and forced WASM.
- The final forced-WASM run passes 148 tests across eleven affected suites.
- Native resolver, framework, graph, context, sync-convergence, and explore
  budget checks pass. The final expanded guard/parity run passes 94 tests.
- All 655 extraction tests pass in seven sequential fresh-process batches;
  the union of passing test names is checked against all 655 original cases.
- Native/WASM TS/JS parity passes for the torture fixtures, CRLF forms, real
  source files, and optional/ordinary member chains. Dart parity also passes.
- The C deep-brace guard, shallow-file checks, worker checks, and built CLI
  stress checks pass. The two all-language 60,000-level cases remain outside
  the completed stress result, as explained below.

The original fresh-index corpus checks cover Express, Gin, Django and
Excalidraw. Source-grounded paths pass 11/12 on release, 9/12 on original main,
and 11/12 after repair. The remaining Django compiler path is absent in both
original versions. Original integrity, foreign-key and orphan checks pass on
all 44 retained corpus indexes; no-op sync preserves all fingerprinted edge
sets. Existing Gin and Django edit/restore drift is not repaired by this
change.

## Runtime limitations

The monolithic extraction suite's worker receives `SIGKILL` as its resident
memory grows to roughly 1.6–1.7 GB; sampled JS heap use is only 70–95 MB. Dense
C++ fixtures and subsequent indexing setup produce substantial native memory
growth. Lowering the JS heap or worker count does not resolve it. Fresh
batches keep peak child RSS below approximately 0.8 GB and run every assertion
successfully. This distinguishes the resource/lifetime sensitivity from the
ten reproducible assertion failures, but does not identify the exact native
allocation-retention cause.

Standalone Scala expressions nested 60,000 levels did not finish within a
45-second diagnostic budget in either native or WASM; equally deep block
expressions did not avoid the parser limitation. The existing stress tests
are unchanged. There is no claim of a full green monolithic suite or a repair
of this extreme-input parsing limit.

These checks do not cover other operating systems, a long-running watcher,
MCP transport latency, or the paid agent A/B harness. Shared-host timing was
noisy, particularly for Excalidraw, and is not used to claim a performance win.
