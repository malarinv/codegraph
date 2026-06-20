# Dispatch-Synthesizer Backlog — the "dispatch-through-indirection" family

**Audience:** a Claude agent continuing the coverage mission.
**Relationship to the playbook:** this is a *cross-cutting* companion to
[`dynamic-dispatch-coverage-playbook.md`](./dynamic-dispatch-coverage-playbook.md).
The playbook's §6 matrix is organized by **language × framework**. This doc is
organized by **dispatch *shape*** — because a single framework can contain several
distinct indirection shapes (Redux alone is ≥2: hand-written thunks vs RTK Query),
and several shapes recur identically across many frameworks/languages (a name→class
registry is the same problem in trezor `connect`, n8n nodes, and a VS Code command
palette). Redux-thunk (`synthesizedBy:'redux-thunk'`) was the first member shipped;
this is the queue behind it.

Status legend (matches the playbook): ✅ done+validated · 🟡 shipped but under-validated
· 🔬 hole identified · ⬜ not started · ⛔ deliberately not built (silent beats wrong).

---

## The discipline (lessons already paid for — read before building any of these)

1. **Build against ≥2 real repos that *contain the pattern*, from the start.**
   redux-thunk was tuned on **trezor-suite alone (n=1)**. The obvious second repo,
   **shapeshift/web**, fires **0** redux-thunk edges — and that 0 is *correct*:
   shapeshift has **zero** `createAsyncThunk`/`createThunk` (it's an **RTK Query**
   codebase, 14 `createApi` files). So shapeshift could neither confirm nor refute
   generalization — it doesn't contain the shape. **A synthesizer validated on one
   repo is unvalidated.** Pick the validation repos *by grepping for the pattern
   first*, not by reputation.

2. **"One framework" ≠ "one shape."** The trezor→shapeshift split is the proof:
   - `createAsyncThunk` + thunk→thunk `dispatch(Y())` chains → **redux-thunk** ✅ (trezor)
   - `createApi` + `builder.query/mutation` endpoints → hooks/components → **RTK Query** 🔬 (shapeshift) — a *different, unbuilt* synthesizer
   - plain `dispatch(action)` → matching `reducer`/slice `case` → **slice-dispatch** ⬜
   Don't let "we did Redux" hide two-thirds of Redux.

3. **Precision is free recall's price.** redux-thunk's 0-on-shapeshift is the *good*
   kind of zero (no false edges on a non-thunk repo — same bar as the playbook's
   "0 on every non-pattern control"). Every synthesizer below must show **0 on a
   control that lacks the shape** *and* **non-zero + precise on ≥2 that have it**.

4. **Two-part master lever still governs.** An edge only helps if a *realistic
   symbol-named explore seeds a path it lies on*. A synthesizer whose far endpoint
   no normal query names buys nothing (the trezor "11 explores" tail). Prefer shapes
   where both endpoints are names an agent would actually type.

5. **Partial coverage is worse than none** (playbook §7). Close each flow
   *end-to-end* and re-measure; never ship a half-bridged flow.

---

## The backlog (prioritized by frequency × static-resolvability × query-seedability)

### Tier A — high traffic, cleanly static, build next

| Shape | Ecosystem | The static anchor that bridges it | Mechanism | Status |
|---|---|---|---|---|
| **Name→class registry / command bus** | any (TS, .NET, Java, Go…) | a registry `{key: Class}` (object literal *or* module-namespace export) + a call naming `key`; bridge `key → Class.run/handle` by literal-key match, else camel↔Pascal convention | S (fan-out + name-match) | 🔬 **the most generalizable one.** trezor `getMethod` (`methods[method]→new MethodConstructor`), n8n node registry, VS Code commands, webpack loaders. **Hard sub-case:** trezor resolves via *dynamic import of a computed path* + runtime-string index + **case transform** (`'signTransaction'`→`SignTransaction`) — a fan-out (dispatcher→all registered classes) gated by name-match, like `gin-middleware-chain`. |
| **RTK Query** | TS / Redux Toolkit | `createApi({ endpoints: b => ({ getX: b.query(...) }) })` → generated `useGetXQuery` hook → component; endpoint name ↔ hook name (`getX`↔`useGetXQuery`) is convention | X (extract endpoints) + S (endpoint→hook) | 🔬 **found on shapeshift** (14 `createApi` files, currently invisible). The modern RTK default — likely higher traffic than hand thunks now. |
| **Vuex / Pinia** | Vue | `store.dispatch('ns/action')` / `commit('mutation')` → action/mutation by string key (namespaced) | S (string-keyed, like `event-emitter`) | ⬜ |
| **NgRx effects** | Angular | `createEffect(() => actions.pipe(ofType(LoginAction), …))` → effect handler; `Store.dispatch(new LoginAction())` → effect by action type/class | S (type/class-keyed) | ⬜ |

### Tier B — backend command/event/message buses (each needs its own canonical flow + ≥2 repos)

| Shape | Ecosystem | Anchor | Mechanism | Status |
|---|---|---|---|---|
| **MediatR / CQRS** | .NET | `IRequest<T>` → `IRequestHandler<TReq,T>` by the generic request type; `_mediator.Send(new GetFooQuery())` → handler | S (generic-type-keyed) | 🔬 named a frontier in CLAUDE.md, but it's statically keyable via the generic — worth a real attempt |
| **Celery / Sidekiq** | Python / Ruby | `@task`/`@shared_task` + `.delay()`/`.apply_async()`; `Worker.perform_async` → `perform` | R/X (decorator + name) | ⬜ |
| **Laravel / Spring events** | PHP / Java | `event(OrderShipped::class)` → `EventServiceProvider` listener map; `@EventListener onX(EventT)` → publisher by event type | R (mapped) | ⬜ |

### Tier C — frontier, ⛔ do **not** build (no static anchor; would add noise)

| Shape | Why not | 
|---|---|
| **RxJS subscribe** | observable→observer is predominantly *anonymous* closures; no name to seed (playbook ⬜, deferred) |
| **MobX / Vue-reactivity / Solid signals** | Proxy reactive runtime — the edge doesn't exist statically at all; silent beats wrong (matches vue-core deferral) |
| **Redux-Saga** | generator `yield put()` / `takeEvery(ACTION, saga*)` — generator-body dispatch, materially harder; revisit only if a real repo demands it |

### Already shipped (for context)

| Shape | `synthesizedBy` | Validated on |
|---|---|---|
| Redux thunk | `redux-thunk` | ✅ **generalizes (2026-06-20)** — precise on uwave-web (small, 5 edges), session-desktop (medium, 2), trezor (large, 211); control shapeshift (RTK Query, no thunks) = 0. Receiver-agnostic (`api.dispatch`/`thunkApi.dispatch`/`window.…dispatch` all matched). **⚠️ 2 follow-ups below.** |
| (see playbook §6 / `callback-synthesizer.ts` for the other ~20 channels) | | |

### redux-thunk follow-ups (found by the n>1 validation — this is exactly what it's for)

1. **Precision: name-collision target resolution — ✅ FIXED (2026-06-20).** `reduxThunkEdges`
   resolved the dispatched name via `getNodesByName(name).find(kind ∈ {constant,function,
   method})` — first match wins, no preference for the thunk. On **octo-call**, `leaveCall`
   collides (a `createAsyncThunk` const at `state/call.ts:201` *and* a service `function`
   at `services/firestore-signaling.ts:253`); **both** edges mis-resolved to the *service
   function*. trezor's long unique thunk names hid this. **Fix:** resolution now prefers a
   thunk-signature const > other const > same-file callable > first match (single-candidate
   unaffected). Verified: octo-call's 2 edges now target the thunk (`call.ts:201`); uwave's 5
   unchanged; regression test in `__tests__/redux-thunk-synthesizer.test.ts`.
2. **Surfacing: synth edges between non-callable nodes were invisible — ✅ ROOT-CAUSED + FIXED
   (2026-06-20).** redux-thunk connects `constant` nodes (thunks are `const X=createAsyncThunk`),
   but explore's flow machinery assumed callables, so the hop fell through both surfacing
   paths: **(a)** `buildFlowFromNamedSymbols` filtered its named set to
   `CALLABLE={method,function,component,constructor}` (tools.ts:1554) → constants never entered
   the Flow scan / #687 Dynamic-dispatch-links loop, at any tier; **(b)** the kind-agnostic
   `### Relationships` section (which *does* render constant→constant) is
   `includeRelationships:false` below 500 files. Net: redux-thunk edges surfaced ONLY via
   Relationships, ONLY on repos ≥500 files (uwave/octo-call showed nothing). **Fix (surgical,
   tier-independent):** a `dynNamed` set of named CONSTANT/VARIABLE/FIELD nodes that participate
   in a heuristic edge feeds the `## Dynamic-dispatch links` scan (main call-chain stays
   callable-only); plus a generic `synthEdgeNote` fallback so any synth hop reads
   `dynamic: <kind> @wiring-site`, not a bare `[calls]`. Verified: uwave `shufflePlaylist→
   loadPlaylist` and `register→login→initState` now surface; trezor unchanged; full suite +
   new `__tests__/explore-synth-constant-endpoints.test.ts` pass. **No-op for callable flows**
   (dynNamed stays empty) — so it generalizes: any future constant/variable/field-connecting
   synth (RTK Query, Vuex) surfaces for free.

---

## Per-synthesizer validation protocol (condensed from the playbook)

For each shape, before marking ✅:
1. **Grep ≥3 real repos for the pattern**; keep the **2+ that contain it** (small/medium)
   + **1 control that lacks it**. (Graph-level precision/recall validation does **not**
   need not-trained-on repos — that constraint is only for *agent A/B baselines*.)
2. **Measure the hole**: `select count(*) from edges where synthesizedBy='X'` →
   non-zero + node count stable (no explosion) on the pattern repos; **0 on the control**.
3. **Precision spot-check**: sample ~12 edges; source & target must both be real and the
   indirection must actually exist in the source body.
4. **Seed a flow**: `scripts/agent-eval/probe-explore.mjs` with the shape's endpoint
   symbol names → the Flow section shows the path through the synthesized hop.
5. **Agent A/B** (only for the headline repo, not every control): `--model sonnet
   --effort high`, n≥2/arm, record Read/Grep/duration.

---

## Immediate next actions

- [ ] **Validate redux-thunk for real (workstream 1):** clone a small + medium
      `createAsyncThunk`-using app (grep-confirmed), re-index, repeat the protocol.
      Promote `redux-thunk` 🟡→✅ or fix the overfit. *(None of the 4 already-cloned
      eval repos contain `createAsyncThunk`.)*
- [ ] **Decide trezor end (workstream 3):** the **name→class registry** synthesizer is
      the valuable, generalizable Tier-A item (closes trezor's `getMethod` end *and*
      n8n/VS-Code-class registries). The **facade** (`connect-common/factory.ts`) is
      **low-value** — it collapses every method to a single `call` fan-in with no
      per-method disambiguation; bridging it buys ~nothing. Build the registry, skip the facade.
- [ ] **RTK Query (workstream 2 spillover):** shapeshift handed us a free, real,
      already-indexed target. Strong candidate right after redux-thunk is de-risked.
