/**
 * `GET /api/steps` — what happens from here: a screen, a handler or any
 * symbol as the ANCHOR, and everything it sets in motion drawn as typed steps.
 *
 * The Screens view (`screens.ts`) is already a picture of steps with one step
 * type: it folds `HomeScreen → ItemsGrid → ItemCard → openObjectDetail` into
 * one arrow labelled with its condition, because the reader wants the
 * transition, not the plumbing. This endpoint keeps that fold and widens the
 * set of things worth a box. Walking FORWARD from the anchor over calls,
 * renders, handler bindings and navigations, a node is a step when it is:
 *
 * - a **screen** (a route reached over a `navigates` edge),
 * - a **trigger** — a function wired as a value (`onPress={handleX}`,
 *   `addListener('x', handleX)`), the user's or the platform's way in,
 * - a **bridge** call — the language changes under the call, JS → native
 *   (the React Native bridge resolver's edges, or any family crossing),
 * - a native **event** landing back in JS (`sendEvent(withName:)` → the
 *   listener, via the RN event channel),
 * - a **store** action — a function in a store file, the state it writes,
 * - an **effect** — a call that leaves the index into the network, storage,
 *   the device or telemetry, drawn as its own box beside the function that
 *   makes it.
 *
 * Everything else — hooks, helpers, services, the components between a
 * screen and its handlers — is `via`: listed on the link, never a box. The
 * branch conditions along the folded chain join into the link's `when`, read
 * from the source at request time exactly as the Screens view reads them.
 *
 * The picture is finite because it is ANCHORED and CAPPED, not because the
 * graph is small: a bounded depth in steps, a bounded fan-out per node, a
 * bounded number of nodes folded per step, and hubs and shared chrome (a top
 * bar rendered on ten screens) are dead ends rather than paths. Every cap
 * that fired is reported on the step it fired at, so a short picture never
 * reads as "nothing else happens here".
 *
 * Read from the graph at request time, never cached: the `when` labels and
 * the effect sites are read from the source as it stands.
 */

import type CodeGraph from '../../index';
import type { Edge, Language, Node, UnresolvedReference } from '../../types';
import { badRequest, intParam, notFound } from './respond';
import { createSiteReader } from './when';
import type { SiteTrigger } from '../../graph/branch-guards';
import { classifyEffect, responseStatus, type Effect } from './effects';
import { looksLikeComponent, routeRoots } from './route-roots';
import { splitRouteName } from './routes';
import { HUB_THRESHOLD, UNCERTAIN_BELOW, toNodeRef, type WireNodeRef } from './wire';
import { isTestPath } from '../../search/query-utils';

// =============================================================================
// Wire shapes
// =============================================================================

export type WireStepKind = 'anchor' | 'screen' | 'trigger' | 'bridge' | 'event' | 'store' | 'effect';

export type WireStepLinkKind = 'calls' | 'navigates' | 'handler' | 'bridge' | 'event' | 'store' | 'effect';

export interface WireStepSite {
  file: string;
  line: number;
  /** `push /capture`, `calls`, `client.post` — what the site does, in a word or two. */
  text: string;
  /**
   * What the site passes, as written and abbreviated: `'userEmail',
   * values.email`, `'/auth/login', { email, password }`. '' for an empty
   * argument list; absent when the source could not be read.
   */
  args?: string;
  /**
   * The conditions THIS site runs under — the whole chain's, joined; '' when
   * unconditional. A link with several sites is several scenarios (four
   * early returns that each go home), and the viewer lists them as rows with
   * the clauses they share factored out; the link's own `when` is only the
   * summary of all of them.
   */
  when: string;
  /** What fires THIS site, when it differs from the link's first. */
  trigger?: WireStepTrigger;
  /** For a response site: the status code it sends, when literal (`res.status(404)`, `throw new NotFoundException`). */
  status?: number;
}

/** What fires a step or a link: the event it is written under, and the function that writes it there. */
export interface WireStepTrigger extends SiteTrigger {
  /** The function the binding is written in — `LoginButton` for its `onPress`. */
  in: string;
}

export interface WireStep {
  /** The node's id, or `effect:<function id>:<api>` for a call leaving the index. */
  id: string;
  kind: WireStepKind;
  /** The step the picture starts from. A screen anchor keeps `kind: 'screen'`. */
  anchor: boolean;
  /** Null only for an effect, which is a call site rather than a symbol. */
  node: WireNodeRef | null;
  /** `/capture/review`, `handleApproveAllImages`, `client.post`. */
  label: string;
  /** The component for a screen, the file for a symbol, the category and caller for an effect. */
  sub: string;
  /** Steps from the anchor: the row. */
  depth: number;
  /**
   * Why the walk did not go on from this step, when it did not: a cap it hit
   * (`depth`, `fan-out`, `folded`, `steps`), or `screen` — another screen is
   * a chapter of its own, drawn but not entered unless `through` asks.
   */
  cut: 'depth' | 'fan-out' | 'folded' | 'steps' | 'screen' | 'component' | null;
  /** The event name a native event step arrived on (`onZipComplete`) — the first, when several land here. */
  event?: string;
  /** Every event that lands on this step, in the order the walk met them. */
  events?: string[];
  /** For a handler: what fires it — the first binding the walk met. */
  trigger?: WireStepTrigger;
  /**
   * For a screen or an endpoint: its path and the symbol that serves it — the
   * component a screen renders, the handler an endpoint runs. `endpoint` when
   * the route leads with an HTTP verb (`POST /users`); `inline` when the
   * handler is an anonymous function at the registration site, so the route
   * itself stands in for it and `component` is null.
   */
  screen?: { path: string; component: WireNodeRef | null; endpoint: boolean; inline: boolean };
  /**
   * For an effect: the calls one function makes into one category — `api` is
   * the first, `apis` all of them — and the function that makes them. A
   * database call also says the model / table it touches when the call
   * names one, and whether it reads or writes; a response box lists the
   * status codes its sites send.
   */
  effect?: {
    api: string;
    apis: string[];
    category: string;
    by: WireNodeRef;
    line: number;
    model?: string;
    access?: 'read' | 'write';
    statuses?: number[];
  };
}

export interface WireStepLink {
  id: string;
  from: string;
  to: string;
  kind: WireStepLinkKind;
  /** The symbols folded between the two steps, in order. */
  via: WireNodeRef[];
  /** Conditions along the whole chain, joined; '' when unconditional. */
  when: string;
  /** How the last hop was established when it was not a plain call — `via rn-event-channel · registered at file:line`. */
  label: string;
  synthesized: boolean;
  uncertain: boolean;
  sites: WireStepSite[];
  /** What fires the first site, when something binds it to an event. */
  trigger?: WireStepTrigger;
}

export interface WireStepsPayload {
  anchor: WireNodeRef;
  /** Other symbols that share the anchor's name, when it was given by name. */
  ambiguous: WireNodeRef[];
  /**
   * What the index is a picture of, decided from its routes: an `app` of
   * screens, an `api` of endpoints, or a `web` app with both. The viewer's
   * words (screen / endpoint, store action / data) follow it.
   */
  project: 'app' | 'api' | 'web';
  steps: WireStep[];
  links: WireStepLink[];
  depth: number;
  limit: number;
  /** Screens reached from the anchor were entered rather than drawn as boundaries. */
  through: boolean;
  truncated: {
    /** Steps not added because the picture reached `limit`. */
    steps: number;
    /** Folded walks that stopped at a hub (fan-in ≥ the hub threshold). */
    hubs: number;
    /** Folded walks that stopped at shared chrome (a component rendered by several screens). */
    chrome: number;
  };
  index: { lastIndexedAt: number | null; edges: number; files: number };
  timing: { elapsedMs: number };
}

// =============================================================================
// Caps
// =============================================================================

export const DEFAULT_DEPTH = 8;
export const MAX_DEPTH = 14;
export const DEFAULT_LIMIT = 120;
export const MAX_LIMIT = 400;
/** Nodes folded while exploring from ONE step before the walk stops. */
const MAX_FOLDED_PER_STEP = 300;
/** Hops of folded plumbing between two steps. */
const MAX_FOLD_DEPTH = 7;
/** Outgoing edges followed from one node; past this the node is a god function and the rest is announced. */
const MAX_FANOUT = 80;
/** Unresolved-reference scans (for effects) per request. */
const MAX_EFFECT_SCANS = 800;
/** Call sites read for conditions and arguments per request. */
const MAX_WHEN_SITES = 1600;
/** Call sites read for the callee as written (effect classification) per request — lookups on trees the guards parsed anyway. */
const MAX_CALL_SITES = 4000;
/** Longest effect-box label before its argument list is cut. */
const MAX_EFFECT_LABEL = 56;
/**
 * A component rendered by this many distinct parents is chrome (a top bar, a
 * button), not a screen's own behaviour. Higher than the Screens view's 3: that
 * one attributes navigations, where three screens sharing a link is already
 * chrome; this one decides what to WALK INTO, and a capture component shared
 * by three capture flows is the screen's whole body.
 */
const SHARED_CHROME_MIN = 5;

/** Edges walked forward. `contains` only function → function (a hook's handlers); `references` only function-as-value. */
const WALK_KINDS: Edge['kind'][] = ['calls', 'instantiates', 'navigates', 'references', 'contains'];

// =============================================================================
// Classification
// =============================================================================

const JS_FAMILY: ReadonlySet<Language> = new Set<Language>(['javascript', 'typescript', 'tsx', 'jsx']);
const NATIVE_FAMILY: ReadonlySet<Language> = new Set<Language>(['swift', 'objc', 'java', 'kotlin']);

/** JS → native is a bridge call; native → JS is an event. Anything else is one family. */
export function crossing(from: Language, to: Language): 'bridge' | 'event' | null {
  if (JS_FAMILY.has(from) && NATIVE_FAMILY.has(to)) return 'bridge';
  if (NATIVE_FAMILY.has(from) && JS_FAMILY.has(to)) return 'event';
  return null;
}

/**
 * A file that holds state: a store, a slice, a reducer. The graph has no
 * "store" kind — a Zustand action is an ordinary function node — so the file
 * is the evidence, and the legend says so.
 */
export const STORE_FILE = /(?:^|\/)(?:stores?|storage|state|slices?|reducers?)\/|\.(?:store|storage|slice|reducer)\.[cm]?[jt]sx?$/i;

export function isStoreFile(file: string): boolean {
  return STORE_FILE.test(file.replace(/\\/g, '/'));
}

/**
 * What a call is when it leaves the index, by the reference text alone — the
 * mobile app's table, kept for callers that have no language in hand. The
 * Steps walk itself classifies on the call AS WRITTEN with the language and
 * the project kind (`effects.ts`).
 */
export function effectCategory(referenceName: string): string | null {
  return classifyEffect({ text: referenceName, kind: 'calls' })?.category ?? null;
}

/** A method of a repository / DAO / mapper, by the container's name — the ORM boundary in a project that types it. */
const REPOSITORY_CONTAINER = /(?:Repository|Repositories|Repo|Dao|DAO|Mapper|Store|Datastore)$/;

/** Decorators that gate a handler: guards, interceptors, pipes, roles, auth, validation, transactions, throttles. */
const GUARD_DECORATOR =
  /^(?:UseGuards|UseInterceptors|UsePipes|UseFilters|Roles|Auth|Public|Permissions|Throttle|SkipThrottle|Authorize|AllowAnonymous|PreAuthorize|PostAuthorize|Secured|RolesAllowed|PermitAll|DenyAll|Transactional|Validated|login_required|permission_required|user_passes_test|staff_member_required|require_http_methods|require_POST|require_GET|csrf_exempt|csrf_protect|ratelimit|throttle_classes|permission_classes|authentication_classes|cache_page|ValidateAntiForgeryToken|RequireAuthorization|RequireRole|RequireHttps|EnableCors|CrossOrigin|Cacheable|CacheEvict|CachePut|RateLimiter|CircuitBreaker|Retry|Timeout|Bulkhead|jwt_required|Security|ApiBearerAuth|ApiKeyAuth|BearerAuth|OAuth|Scopes|Roles|HasRole|HasPermission|Idempotent|Lock|Locked|Retryable|Recover)$|Guard|Interceptor|Pipe$|Filter$|Auth|Role|Permission|Throttle|Valid|Transaction|Csrf|Limit/i;
/** Decorators that ARE the route, the DI wiring, or documentation — never a guard. */
const NOT_A_GUARD =
  /^(?:Get|Post|Put|Patch|Delete|Head|Options|All|Controller|RestController|Resolver|Query|Mutation|Subscription|Injectable|Module|Api\w*|Http(?:Get|Post|Put|Patch|Delete|Head|Options)|Route|RequestMapping|\w+Mapping|Component|Service|Repository|Bean|Autowired|Override|Inject|Param|Body|Res|Req|Headers|Ip|HostParam|Session|UploadedFiles?|HttpCode|Header|Redirect|Render|Version|SerializeOptions|ResponseBody|ResponseStatus|Produces|Consumes|FromBody|FromRoute|FromQuery|FromForm|FromHeader|FromServices|Path|PathVariable|RequestParam|RequestBody|RequestHeader|ModelAttribute|Valid|Args|Context|Parent|Info|Field|ObjectType|InputType|ArgsType|Entity|Column|PrimaryGeneratedColumn|OneToMany|ManyToOne|Prop|Schema|Type|Expose|Exclude|Transform|IsString|IsNumber|IsOptional|Length|Min|Max|Deprecated|SuppressWarnings|FunctionalInterface|Slf4j|Data|Builder|Getter|Setter|NoArgsConstructor|AllArgsConstructor|RequiredArgsConstructor|Value|ConfigurationProperties|Configuration|EnableScheduling|SpringBootApplication|Profile|Order|Primary|Qualifier|Lazy|Scope|JsonProperty|JsonIgnore|Nullable|NonNull|NotNull|Size|Pattern|Email|Positive|router\.\w+|app\.\w+|api\.\w+|bp\.\w+|blueprint\.\w+|\w+\.(?:route|get|post|put|patch|delete))$/;
/** Decorators that fire a function from outside a request: a job, an event, a message, a schedule. */
const CONSUMER_DECORATOR =
  /^(?:Process|Processor|OnEvent|OnQueueEvent|OnWorkerEvent|OnGlobalQueueEvent|Cron|Interval|Timeout|MessagePattern|EventPattern|SubscribeMessage|Scheduled|Schedules?|KafkaListener|RabbitListener|RabbitSubscribe|RabbitRPC|JmsListener|SqsListener|SqsMessageHandler|EventListener|TransactionalEventListener|StreamListener|ServiceActivator|receiver|shared_task|task|periodic_task|app\.task|celery\.task|on|hears|command|event|listen|listener|Consume|Consumer|Subscribe|Subscriber|CapSubscribe|Function|FunctionName|TimerTrigger|QueueTrigger|ServiceBusTrigger|EventGridTrigger|BlobTrigger|CosmosDBTrigger|Job|job|Worker|worker|EventHandler|CommandHandler|QueryHandler|OnMessage|MessageHandler|GrpcMethod|GrpcStreamMethod|WebSocketGateway|dramatiq\.actor|actor|huey\.task|db_task|Signal|signal|hook|Hook|OnModuleInit|OnApplicationBootstrap|PostConstruct|PreDestroy|Bean|Startup|Shutdown)$/;

/** The name of a decorator, before its arguments. */
function decoratorName(text: string): string {
  return text.replace(/\(.*$/s, '').trim();
}

/** The first string literal in a decorator's arguments — `'email'` of `@Process('email')`. */
function decoratorLiteral(text: string): string | null {
  const m = /\(\s*(['"`])((?:(?!\1).)*)\1/.exec(text);
  return m ? `'${m[2]}'` : null;
}

function isGuardDecorator(text: string): boolean {
  const name = decoratorName(text);
  if (NOT_A_GUARD.test(name)) return false;
  return GUARD_DECORATOR.test(name);
}

/** FastAPI: `dependencies=[Depends(auth), Depends(rate_limit)]` inside the route decorator. */
function dependenciesIn(text: string): string[] {
  const m = /dependencies\s*=\s*\[([^\]]*)\]/.exec(text);
  if (!m) return [];
  return m[1]!.split(/,(?![^()]*\))/).map((x) => x.trim()).filter(Boolean);
}

// =============================================================================
// The endpoint
// =============================================================================

interface Fold {
  node: Node;
  /** [first folded node, …, this node]; empty for the step's own root. */
  chain: Node[];
  whens: string[];
}

interface StepRecord extends WireStep {
  /** Where exploration from this step begins: a screen's component, otherwise the node itself. */
  root: Node | null;
}

export async function buildSteps(cg: CodeGraph, projectRoot: string, query: URLSearchParams): Promise<WireStepsPayload> {
  const started = Date.now();
  const depthCap = intParam(query, 'depth', { min: 1, max: MAX_DEPTH, default: DEFAULT_DEPTH });
  const limit = intParam(query, 'limit', { min: 20, max: MAX_LIMIT, default: DEFAULT_LIMIT });
  const through = query.get('through') === '1';
  const stats = cg.getStats();
  const index = { lastIndexedAt: cg.getLastIndexedAt() ?? null, edges: stats.edgeCount, files: stats.fileCount };

  const { anchor, ambiguous } = resolveAnchor(cg, query);

  // Route → where its code starts: the handler a resolver named, the page a
  // screen file exports, or the route itself standing in for an inline
  // handler (`route-roots.ts`) — and what kind of project this is, for the
  // words the viewer uses.
  const routes = cg.getNodesByKind('route');
  const roots = routeRoots(cg, routes);
  const project = projectKind(routes, stats.edgesByKind?.navigates ?? 0);

  const reader = createSiteReader(cg, projectRoot, MAX_WHEN_SITES);
  const calls = createSiteReader(cg, projectRoot, MAX_CALL_SITES);
  const whenAt = (caller: Node, site: { line?: number; column?: number }) => reader.when(caller, site);
  const argsAt = (caller: Node, site: { line?: number; column?: number }) => reader.args(caller, site);
  const withArgs = async (site: WireStepSite, caller: Node, at: { line?: number; column?: number }): Promise<WireStepSite> => {
    const args = await argsAt(caller, at);
    return args === null ? site : { ...site, args };
  };
  /** The call as written at a site, and what it passes — one read for both. */
  const callAt = (caller: Node, site: { line?: number; column?: number; callee?: string }) => calls.callSite(caller, site);

  // The declared type of a receiver: `OwnerRepository owners` in a Spring
  // controller makes `owners.save` the database; `private readonly
  // usersService: UsersService` in a Nest controller says where
  // `this.usersService.findByEmail` goes. The index keeps the first in a
  // field's signature and nothing of the second, so the class body is read
  // from the tree at request time, once per class.
  const fileTypes = new Map<string, Map<string, string>>();
  const classTypes = new Map<string, Map<string, string>>();
  const receiverTypeFor = async (caller: Node, callee: string): Promise<string | null> => {
    const first = callee.replace(/^(?:this|self)\./, '').split(/[.:(]/)[0] ?? '';
    if (!first || /^[A-Z]/.test(first)) return null;
    const declared = await memberTypesOf(caller);
    const own = declared.get(first) ?? declared.get(first.replace(/^_/, '')) ?? null;
    if (own) return own;
    let types = fileTypes.get(caller.filePath);
    if (!types) {
      types = new Map();
      for (const n of cg.getNodesInFile(caller.filePath)) {
        if ((n.kind !== 'field' && n.kind !== 'property' && n.kind !== 'variable' && n.kind !== 'parameter') || !n.signature) continue;
        const sig = n.signature.replace(/\s+/g, ' ').trim();
        // `OwnerRepository owners`, `private final OwnerRepository owners`, `owners: OwnerRepository`, `val owners: OwnerRepository`.
        const typed = new RegExp(`(?:^|\\s)([A-Z][\\w<>,?. ]*?)\\s+${n.name}\\b`).exec(sig) ?? new RegExp(`\\b${n.name}\\s*:\\s*([A-Z][\\w<>,?. ]*)`).exec(sig);
        if (typed && !types.has(n.name)) types.set(n.name, typed[1]!.trim());
      }
      fileTypes.set(caller.filePath, types);
    }
    return types.get(first) ?? null;
  };
  const memberTypesOf = async (node: Node): Promise<Map<string, string>> => {
    const key = `${node.filePath}:${node.startLine}`;
    let types = classTypes.get(key);
    if (!types) {
      types = await calls.memberTypes(node);
      classTypes.set(key, types);
    }
    return types;
  };

  // Where a member call really goes, by the receiver's declared type: the
  // class named by the type, and its method of the call's name. Null when the
  // type names nothing in the index (an ORM's `Repository<Cat>`) — then the
  // call leaves the index, and the effect table says as what.
  const classByName = new Map<string, Node | null>();
  /** The class / interface / struct a declared type names in the index, or null for a library's. */
  const classOfType = async (type: string): Promise<Node | null> => {
    const typeName = type.replace(/<.*$/, '').replace(/^[*&]+/, '').replace(/[?!]$/, '').split(/[.:]/).pop()?.trim() ?? '';
    if (!typeName || /^(?:string|number|boolean|any|unknown|object|void|String|Integer|Long|Boolean|int|long|bool|var|dynamic|Object|List|Map|Set|Array|Promise|Optional|Task|IEnumerable|Iterable)$/.test(typeName)) return null;
    let cls = classByName.get(typeName);
    if (cls === undefined) {
      const found = cg.getNodesByName(typeName).filter((n) => n.kind === 'class' || n.kind === 'interface' || n.kind === 'struct');
      cls = found.find((n) => !isTestPath(n.filePath)) ?? found[0] ?? null;
      classByName.set(typeName, cls);
    }
    return cls;
  };
  const resolveByReceiver = async (caller: Node, callee: string): Promise<Node | null> => {
    const segments = callee.replace(/\([^()]*\)/g, '').split(/[.:]+/).filter(Boolean);
    if (segments.length < 2) return null;
    const type = await receiverTypeFor(caller, callee);
    if (!type) return null;
    const cls = await classOfType(type);
    if (!cls) return null;
    const method = segments[segments.length - 1]!;
    const members = cg.getNodesInFile(cls.filePath).filter((n) => (n.kind === 'method' || n.kind === 'function') && n.name === method && n.startLine >= cls!.startLine && n.endLine <= cls!.endLine);
    return members[0] ?? null;
  };

  /** A method the walk cannot enter (an interface's, an ORM's) on a repository-shaped container. */
  const repositoryMethod = (target: Node): boolean => {
    if (target.kind !== 'method' && target.kind !== 'function') return false;
    if (isTestPath(target.filePath)) return false;
    const container = target.qualifiedName.replace(/[.:]+[^.:]*$/, '').split(/[.:]+/).pop() ?? '';
    if (!REPOSITORY_CONTAINER.test(container) && !/(?:^|\/)(?:repositories|repository|dao|daos|mappers)\//i.test(posix(target.filePath))) return false;
    return cg.getOutgoingEdgesFrom([target.id], WALK_KINDS).length === 0;
  };

  /** What runs before a route's handler: the middleware arguments at the registration, or the guard decorators on it. */
  const chainFor = async (route: Node, root: Node | null): Promise<string[]> => {
    const after: string[] = [];
    if (JS_FAMILY.has(route.language)) {
      const site = await calls.callSite(route, { line: route.startLine, column: 0 });
      if (site && /\.(?:get|post|put|patch|delete|all|use|head|options|route)$/i.test(site.callee)) {
        const args = site.argList.slice(1);
        if (args.length > 0 && !/^\{/.test(args[args.length - 1]!)) args.pop();
        for (const a of args) if (a && !/^\{ ?…? ?\}$/.test(a)) after.push(a);
      }
    }
    if (root && root.id !== route.id) {
      const decs = await calls.decorators(root);
      if (decs) {
        for (const d of [...decs.class, ...decs.own]) {
          if (!JS_FAMILY.has(root.language) && !/^(?:python)$/.test(root.language)) {
            if (isGuardDecorator(d)) after.push(d);
            continue;
          }
          for (const dep of dependenciesIn(d)) after.push(dep);
          if (isGuardDecorator(d)) after.push(d);
        }
      }
    }
    return [...new Set(after)];
  };

  /** The request a route's handler serves, as its trigger. */
  const requestTrigger = async (route: Node, root: Node | null): Promise<WireStepTrigger | null> => {
    const { method, path } = splitRouteName(route.name);
    if (method === null) return null;
    const after = await chainFor(route, root);
    return { kind: 'request', name: method, of: path, in: basename(route.filePath), ...(after.length > 0 ? { after } : {}) };
  };

  /** A job, an event, a message or a schedule that fires a function, from its decorators. */
  const consumerTrigger = async (node: Node): Promise<WireStepTrigger | null> => {
    if (node.kind !== 'function' && node.kind !== 'method') return null;
    const decs = await calls.decorators(node);
    if (!decs) return null;
    for (const d of decs.own) {
      const name = decoratorName(d);
      const last = name.split('.').pop() ?? name;
      if (!CONSUMER_DECORATOR.test(name) && !CONSUMER_DECORATOR.test(last)) continue;
      const guards = [...decs.class, ...decs.own].filter((x) => x !== d && isGuardDecorator(x));
      return { kind: 'decorator', name, of: decoratorLiteral(d), in: basename(node.filePath), ...(guards.length > 0 ? { after: guards } : {}) };
    }
    return null;
  };

  const steps = new Map<string, StepRecord>();
  const links = new Map<string, WireStepLink>();
  const truncated = { steps: 0, hubs: 0, chrome: 0 };
  let effectScans = 0;
  const fanIn = new Map<string, number>();
  const chromeParents = new Map<string, number>();
  const fileScopeRefs = new Map<string, Edge[]>();

  const stepFor = (node: Node, kind: WireStepKind, depth: number, extra: Partial<WireStep> = {}): StepRecord | null => {
    const existing = steps.get(node.id);
    if (existing) {
      // A listener the screen registers is a handler when first met, and the
      // native event's landing when the walk arrives from the other side —
      // the second is the fuller fact, and it names the event.
      if (existing.kind === 'trigger' && kind === 'event') {
        existing.kind = 'event';
        if (extra.event) existing.event = extra.event;
      }
      if (kind === 'event' && extra.event) {
        existing.events = existing.events ?? (existing.event ? [existing.event] : []);
        if (!existing.events.includes(extra.event)) existing.events.push(extra.event);
      }
      return existing;
    }
    if (steps.size >= limit) {
      truncated.steps++;
      return null;
    }
    const isRoute = node.kind === 'route';
    const routeRoot = isRoute ? (roots.get(node.id) ?? null) : null;
    const record: StepRecord = {
      id: node.id,
      kind: isRoute ? 'screen' : kind,
      anchor: false,
      node: toNodeRef(node),
      label: node.name,
      // A screen says its component, an endpoint its handler; a route the
      // graph bound to nothing says only where it is registered.
      sub: isRoute
        ? routeRoot === null
          ? basename(node.filePath)
          : routeRoot.inline
            ? `inline handler · ${basename(node.filePath)}`
            : routeRoot.node.name
        : posix(node.filePath),
      depth,
      cut: null,
      ...extra,
      root: isRoute ? (routeRoot?.node ?? null) : node,
    };
    if (kind === 'event' && extra.event) record.events = [extra.event];
    if (isRoute) {
      record.screen = {
        path: node.name,
        component: routeRoot !== null && !routeRoot.inline ? toNodeRef(routeRoot.node) : null,
        endpoint: splitRouteName(node.name).method !== null,
        inline: routeRoot?.inline ?? false,
      };
    }
    steps.set(node.id, record);
    return record;
  };

  // One box per (function, category): `uploadARCapture` makes one network
  // call, three storage calls and three telemetry calls — three boxes, each
  // listing its calls, not seven.
  const effectSub = (e: NonNullable<WireStep['effect']>, by: Node): string =>
    [e.category, e.model, e.access, by.name].filter((x): x is string => !!x).join(' · ');
  const effectStep = (by: Node, ref: { referenceName: string; line: number }, effect: Effect, depth: number): StepRecord | null => {
    const category = effect.category;
    const id = `effect:${by.id}:${category}`;
    const existing = steps.get(id);
    if (existing) {
      const e = existing.effect!;
      if (!e.apis.includes(ref.referenceName)) {
        e.apis.push(ref.referenceName);
        existing.label = `${e.apis[0]} +${e.apis.length - 1}`;
      }
      // Several models behind one box: list them; several accesses: say both.
      if (effect.model && e.model !== effect.model) {
        const models = new Set((e.model ?? '').split(', ').filter(Boolean));
        models.add(effect.model);
        e.model = [...models].slice(0, 3).join(', ') + (models.size > 3 ? ', …' : '');
      }
      if (effect.access && e.access && e.access !== effect.access) e.access = undefined;
      existing.sub = effectSub(e, by);
      return existing;
    }
    if (steps.size >= limit) {
      truncated.steps++;
      return null;
    }
    const e: NonNullable<WireStep['effect']> = {
      api: ref.referenceName,
      apis: [ref.referenceName],
      category,
      by: toNodeRef(by),
      line: ref.line,
      ...(effect.model ? { model: effect.model } : {}),
      ...(effect.access ? { access: effect.access } : {}),
    };
    const record: StepRecord = {
      id,
      kind: 'effect',
      anchor: false,
      node: null,
      label: ref.referenceName,
      sub: effectSub(e, by),
      depth,
      cut: null,
      effect: e,
      root: null,
    };
    steps.set(id, record);
    return record;
  };

  /** One effect site: the call as written, what it passes, when, what fires it, and — for a response — the status. */
  const effectLink = async (
    step: StepRecord,
    fold: Fold,
    ref: { referenceName: string; referenceKind: 'calls' | 'instantiates'; line: number; column?: number },
    trigger: WireStepTrigger | null,
    fallbackArgs: string | null = null,
    requireReceiver = false
  ): Promise<boolean> => {
    const at = { line: ref.line, column: ref.column };
    const site = await callAt(fold.node, { ...at, callee: ref.referenceName });
    // The site read must be THIS call: its last segment is the reference's.
    const last = (n: string) => n.replace(/\([^()]*\)/g, '').split(/[.:]/).pop() ?? n;
    const usable = !!site && site.callee !== '' && last(site.callee) === last(ref.referenceName);
    const text = usable ? site.callee : ref.referenceName;
    if (requireReceiver && !/[.:>]/.test(text)) return false;
    const args = usable ? site.args : fallbackArgs;
    // The receiver's declared type counts only when the call leaves the
    // index through it: a library's `Repository<Cat>`, or the project's own
    // `OwnerRepository` interface whose `save` comes from Spring Data — never
    // a project class that declares the method, which is a place to walk into.
    const declared = await receiverTypeFor(fold.node, text);
    const receiverType = declared && (await resolveByReceiver(fold.node, text)) === null ? declared : null;
    const effect = classifyEffect({
      text,
      kind: ref.referenceKind,
      language: fold.node.language,
      project,
      receiverType,
      args,
    });
    if (effect === null) return false;
    const target = effectStep(fold.node, { referenceName: text, line: ref.line }, effect, step.depth + 1);
    if (target === null) return true;
    const when = await whenAt(fold.node, at);
    const wireSite: WireStepSite = { file: posix(fold.node.filePath), line: ref.line, text, when: '' };
    if (args !== null) wireSite.args = args;
    if (effect.category === 'response') {
      const status = responseStatus(text, args, ref.referenceKind);
      if (status !== null) wireSite.status = status;
    }
    link(step, target, 'effect', fold.chain, [...fold.whens, when], wireSite, null, trigger ?? (await triggerAt(fold.node, at)));
    return true;
  };

  const link = (
    from: StepRecord,
    to: StepRecord,
    kind: WireStepLinkKind,
    chain: Node[],
    whens: string[],
    site: WireStepSite,
    edge: Edge | null,
    trigger: WireStepTrigger | null = null
  ): void => {
    const meta = (edge?.metadata ?? {}) as Record<string, unknown>;
    const synthesized = edge?.provenance === 'heuristic';
    const confidence = typeof meta.confidence === 'number' ? meta.confidence : null;
    const via = chain.map(toNodeRef);
    const viaKey = via.map((v) => v.id).join('>');
    const id = `${from.id} ${to.id} ${viaKey}`;
    const when = whens.filter((w, i) => w && whens.indexOf(w) === i).join(' && ');
    const stamped: WireStepSite = { ...site, when, ...(trigger ? { trigger } : {}) };
    // A `contains` edge is how a nested handler is FOUND, not a place it is
    // called from: its row stays only while no call site has been seen.
    const structural = (s: WireStepSite) => s.text.startsWith('defines ');
    const existing = links.get(id);
    if (existing) {
      if (structural(stamped) && existing.sites.some((s) => !structural(s))) return;
      if (!structural(stamped) && existing.sites.every(structural)) existing.sites.length = 0;
      // One statement, two references (`res.status(201)` and its `.json(…)`):
      // the outer call is the site, the inner one folds into it.
      const sameLine = existing.sites.findIndex((s) => s.file === site.file && s.line === site.line);
      if (sameLine < 0) existing.sites.push(stamped);
      else if (stamped.text.startsWith(existing.sites[sameLine]!.text) && stamped.text.length > existing.sites[sameLine]!.text.length) {
        existing.sites[sameLine] = stamped;
      }
      if (!existing.trigger && trigger) existing.trigger = trigger;
      if (when !== existing.when) {
        if (!when || !existing.when) existing.when = '';
        else if (!existing.when.split(' || ').includes(when)) existing.when = `${existing.when} || ${when}`;
      }
      return;
    }
    links.set(id, {
      id,
      from: from.id,
      to: to.id,
      kind,
      via,
      when,
      label: hopLabel(meta, synthesized),
      synthesized,
      uncertain: confidence !== null && confidence < UNCERTAIN_BELOW,
      sites: [stamped],
      ...(trigger ? { trigger } : {}),
    });
    if (trigger && to.kind === 'trigger' && !to.trigger) to.trigger = trigger;
  };

  /** What fires a site, with the function it is written in. */
  const triggerAt = async (caller: Node, at: { line?: number; column?: number }): Promise<WireStepTrigger | null> => {
    const t = await reader.trigger(caller, at);
    return t ? { ...t, in: caller.name } : null;
  };

  // The anchor: a screen keeps its kind and explores from its component; an
  // endpoint says the request that fires it and what runs before its handler;
  // a function says the job, event or schedule written on it.
  const first = stepFor(anchor, 'anchor', 0)!;
  first.anchor = true;
  if (anchor.kind === 'route') {
    const t = await requestTrigger(anchor, first.root);
    if (t) first.trigger = t;
  } else {
    const t = await consumerTrigger(anchor);
    if (t) first.trigger = t;
  }
  const queue: StepRecord[] = [first];
  /** Steps whose exploration has been queued — each is explored once, from the first row it appears on. */
  const explored = new Set<string>([first.id]);

  while (queue.length > 0) {
    const step = queue.shift()!;
    if (step.root === null) continue;
    // Another screen is a chapter of its own: the Screens view draws the way
    // between screens, and a picture that walked on through Home would be the
    // whole app. Drawn as a boundary, entered on request.
    if (step.kind === 'screen' && !step.anchor && !through) {
      step.cut = 'screen';
      continue;
    }
    // A native event that lands in a COMPONENT — the capture overlay taking
    // `onCaptureProgress` — lands on another screen's body: its picture is
    // that screen's, not this one's. A boundary too, entered on request.
    if (step.kind === 'event' && !step.anchor && !through && looksLikeComponent(step.root)) {
      step.cut = 'component';
      continue;
    }
    if (step.depth >= depthCap) {
      // Something to explore, and no room in the picture for it.
      if (cg.getOutgoingEdgesFrom([step.root.id], WALK_KINDS).length > 0) step.cut = 'depth';
      continue;
    }

    // Breadth-first through the plumbing until the next steps.
    const visited = new Set<string>([step.root.id]);
    let frontier: Fold[] = [{ node: step.root, chain: [], whens: [] }];
    for (let hop = 0; hop <= MAX_FOLD_DEPTH && frontier.length > 0; hop++) {
      const next: Fold[] = [];
      const ids = frontier.map((f) => f.node.id);
      const outgoing = cg.getOutgoingEdgesFrom(ids, WALK_KINDS);
      const bySource = new Map<string, Edge[]>();
      for (const e of outgoing) {
        const list = bySource.get(e.source) ?? [];
        list.push(e);
        bySource.set(e.source, list);
      }
      // `const Memoized = memo(CaptureComponent)`: the wrapper is a component
      // node with no edges of its own — the inner component is referenced
      // from the FILE scope, at the wrapper's line. Lend the wrapper those
      // references, so the screen that renders `<Memoized/>` walks on into
      // what the component does.
      for (const fold of frontier) {
        if (fold.node.kind !== 'component' || (bySource.get(fold.node.id)?.length ?? 0) > 0) continue;
        for (const e of fileScopeFnRefsWithin(cg, fold.node, fileScopeRefs)) {
          const list = bySource.get(fold.node.id) ?? [];
          list.push({ ...e, source: fold.node.id });
          bySource.set(fold.node.id, list);
        }
      }
      const targetIds = new Set<string>();
      for (const list of bySource.values()) for (const e of list) targetIds.add(e.target);
      const targets = targetIds.size === 0 ? new Map<string, Node>() : cg.getNodesByIds([...targetIds]);
      // Hubs and chrome are judged on the nodes about to be entered.
      const unknownFanIn = [...targetIds].filter((id) => !fanIn.has(id));
      if (unknownFanIn.length > 0) for (const [id, n] of cg.getFanIn(unknownFanIn)) fanIn.set(id, n);

      for (const fold of frontier) {
        // Effects made by this node, folded or not.
        if (effectScans < MAX_EFFECT_SCANS) {
          effectScans++;
          let refs: UnresolvedReference[] = [];
          try {
            refs = cg.getUnresolvedReferencesFrom(fold.node.id);
          } catch {
            refs = [];
          }
          for (const ref of [...refs].sort((a, b) => a.line - b.line || a.column - b.column)) {
            if (ref.referenceKind !== 'calls' && ref.referenceKind !== 'instantiates') continue;
            await effectLink(step, fold, { referenceName: ref.referenceName, referenceKind: ref.referenceKind, line: ref.line, column: ref.column }, null);
          }
        }

        let edges = (bySource.get(fold.node.id) ?? []).slice();
        edges = edges.filter((e) => {
          const meta = (e.metadata ?? {}) as Record<string, unknown>;
          if (e.kind === 'references') return meta.fnRef === true;
          if (e.kind === 'contains') {
            // A function's nested handlers; and, when the walk STARTS at a
            // class (a ViewSet, a class-based view bound to a route), its
            // methods — never a class met on the way, whose methods are not
            // what the caller reached.
            const t = targets.get(e.target);
            const fromFunction = fold.node.kind === 'function' || fold.node.kind === 'method';
            const fromRootClass = fold.node.kind === 'class' && fold.chain.length === 0 && fold.node.id === step.root?.id;
            return (fromFunction || fromRootClass) && !!t && (t.kind === 'function' || t.kind === 'method');
          }
          return true;
        });
        edges.sort((a, b) => (a.line ?? 0) - (b.line ?? 0) || a.target.localeCompare(b.target));
        if (edges.length > MAX_FANOUT) {
          step.cut = 'fan-out';
          edges = edges.slice(0, MAX_FANOUT);
        }

        // Two passes: first every edge that arrives at a step, then the rest —
        // so a node that IS a step (a handler wired to a tap) is never also
        // folded as plumbing by the `contains` edge from the same component.
        interface Arrival {
          e: Edge;
          target: Node;
          meta: Record<string, unknown>;
          site: WireStepSite;
          kind: WireStepKind | null;
          linkKind: WireStepLinkKind;
          extra: Partial<WireStep>;
          trigger: WireStepTrigger | null;
        }
        const arrivals: Arrival[] = [];
        const fromTest = isTestPath(fold.node.filePath);
        for (const e of edges) {
          const found = targets.get(e.target);
          if (!found || found.kind === 'file') continue;
          const meta = (e.metadata ?? {}) as Record<string, unknown>;

          // A member call the index kept only the last segment of (`create`
          // for `prisma.user.create`) resolves by name alone — a guess, and
          // often the wrong one. The call AS WRITTEN decides first: an effect
          // is drawn as one and the guessed edge is not walked. A call through
          // a project-made value (`client.post` on the axios instance) is the
          // same case with the constant as the target.
          let target = targets.get(e.target)!;
          let retargeted = false;
          if (e.kind === 'calls' && typeof meta.synthesizedBy !== 'string' && e.provenance !== 'heuristic') {
            const refName = typeof meta.refName === 'string' ? meta.refName : target.name;
            const bare = !refName.includes('.');
            // A member call whose receiver is declared as a type the index
            // holds no class for (`DataStore<UserPreferences>`) leaves the
            // index too, whatever name-matched — an `updateData` on a test
            // double, say.
            let external = false;
            if (!bare && target.kind !== 'constant' && target.kind !== 'variable') {
              const declared = await receiverTypeFor(fold.node, refName);
              external = !!declared && (await classOfType(declared)) === null;
            }
            if (bare || external || target.kind === 'constant' || target.kind === 'variable') {
              const drawn = await effectLink(step, fold, { referenceName: refName, referenceKind: 'calls', line: e.line ?? fold.node.startLine, column: e.column }, null, null, true);
              if (drawn) continue;
              // Not an effect: does the receiver's declared type say where the
              // call goes? A class in the index wins over the name-only guess.
              if (bare) {
                const written = await callAt(fold.node, { line: e.line, column: e.column, callee: refName });
                if (written && /[.:]/.test(written.callee) && (written.callee.split(/[.:]/).pop() ?? '') === refName) {
                  const real = await resolveByReceiver(fold.node, written.callee);
                  if (real && real.id !== target.id) {
                    target = real;
                    retargeted = true;
                  }
                }
              }
            }
          }
          if (target.id === fold.node.id) continue;
          // A production walk never enters a test double: an interface's
          // dispatch into `TestUserDataRepository`, or a `DataStore` name-matched
          // to the in-memory one, is the test suite's story. Judged after the
          // call as written had its chance to be an effect.
          if (!fromTest && isTestPath(target.filePath)) continue;
          const site: WireStepSite = {
            file: posix(fold.node.filePath),
            line: e.line ?? fold.node.startLine,
            text: siteText(e, meta, target),
            when: '',
          };

          // What fires this hop, when the site is written under an event:
          // the JSX prop, the `on*` option, the runs-later call. Read for
          // every call-shaped hop, so a store action or an effect fired by
          // a tap says so on its link too.
          const isCall = e.kind === 'calls' || e.kind === 'instantiates' || (e.kind === 'references' && meta.fnRef === true);
          const trigger = isCall ? await triggerAt(fold.node, { line: e.line, column: e.column }) : null;

          // What kind of step, if any, this edge arrives at.
          let kind: WireStepKind | null = null;
          let linkKind: WireStepLinkKind = 'calls';
          const extra: Partial<WireStep> = {};
          if (target.kind === 'route') {
            kind = 'screen';
            linkKind = 'navigates';
          } else {
            // A language change under the code is a step only on evidence: a
            // bridge resolver's edge (`bridge`, or a framework resolution), or
            // a synthesized channel's. A plain name-matched call across the
            // families (`arr.flat()` landing on a Swift `flat`) is noise, and
            // is neither drawn nor walked.
            const cross = crossing(fold.node.language, target.language);
            const evidenced = e.provenance === 'heuristic' || meta.bridge === 'react-native' || meta.resolvedBy === 'framework';
            if (cross !== null && !evidenced) continue;
            if (cross === 'event') {
              kind = 'event';
              linkKind = 'event';
              if (typeof meta.event === 'string') extra.event = meta.event;
            } else if (cross === 'bridge') {
              kind = 'bridge';
              linkKind = 'bridge';
            } else if (
              (target.kind === 'function' || target.kind === 'method') &&
              isStoreFile(target.filePath) &&
              !isStoreFile(fold.node.filePath)
            ) {
              // A store action fired straight from a tap stays a store
              // action; the tap is on its link.
              kind = 'store';
              linkKind = 'store';
            } else if (
              (target.kind === 'function' || target.kind === 'method') &&
              !looksLikeComponent(target) &&
              ((e.kind === 'references' && meta.fnRef === true) || trigger !== null)
            ) {
              // A handler: a function passed as a value (`onPress={handleX}`,
              // `addListener('x', handleX)`), or one called from under an
              // event binding (`onPress={() => handleLogin(values)}`,
              // `useFormik({ onSubmit: (v) => handleLogin(v) })`). A
              // component passed as a value (`memo(CaptureComponent)`) is a
              // render hop and folds like one.
              kind = 'trigger';
              linkKind = 'handler';
              if (trigger) extra.trigger = trigger;
            }
          }
          if (retargeted) meta.resolvedBy = 'receiver-type';
          arrivals.push({ e, target, meta, site, kind, linkKind, extra, trigger });
        }

        for (const a of arrivals) {
          if (a.kind === null) continue;
          const fresh = !steps.has(a.target.id);
          const to = stepFor(a.target, a.kind, step.depth + 1, a.extra);
          if (to === null) continue;
          if (fresh && !to.trigger) {
            const t = a.target.kind === 'route' ? await requestTrigger(a.target, to.root) : await consumerTrigger(a.target);
            if (t) to.trigger = t;
          }
          const at = { line: a.e.line, column: a.e.column };
          const when = await whenAt(fold.node, at);
          // A call-shaped hop says what it passes; a navigation already says
          // its href, a handler binding and an event channel pass nothing.
          const site = a.linkKind === 'bridge' || a.linkKind === 'store' || a.linkKind === 'calls' ? await withArgs(a.site, fold.node, at) : a.site;
          link(step, to, a.linkKind, fold.chain, [...fold.whens, when], site, a.e, a.trigger);
          if (to.root !== null && !explored.has(to.id)) {
            explored.add(to.id);
            queue.push(to);
          }
        }

        for (const a of arrivals) {
          if (a.kind !== null) continue;
          const { e, target, meta } = a;

          // A call through a VALUE the effect table knows — `client.post` on
          // the axios instance the project made itself resolves to the
          // `client` constant, not to anything outside the index. The call
          // text is the evidence: the call is the effect, the constant is not
          // a place to walk into.
          // A thrown exception the framework answers with (`throw new
          // NotFoundException(…)` on a class the project defines) is a
          // response, not a place to walk into; a repository's method the
          // walk cannot enter (an interface's, the ORM's) is the database.
          if (e.kind === 'instantiates' && target.kind === 'class') {
            if (await effectLink(step, fold, { referenceName: target.name, referenceKind: 'instantiates', line: e.line ?? fold.node.startLine, column: e.column }, a.trigger)) continue;
          }
          if (e.kind === 'calls' && repositoryMethod(target)) {
            const container = target.qualifiedName.replace(/[.:]+[^.:]*$/, '').split(/[.:]+/).pop() ?? '';
            const api = typeof meta.refName === 'string' && meta.refName.includes('.') ? meta.refName : `${container}.${target.name}`;
            if (await effectLink(step, fold, { referenceName: api, referenceKind: 'calls', line: e.line ?? fold.node.startLine, column: e.column }, a.trigger)) continue;
          }

          // Already a step, reached here by a plain call: a link, not a fold.
          const known = steps.get(target.id);
          if (known) {
            if (known.id !== step.id) {
              const at = { line: e.line, column: e.column };
              const when = await whenAt(fold.node, at);
              link(step, known, 'calls', fold.chain, [...fold.whens, when], await withArgs(a.site, fold.node, at), e, a.trigger);
            }
            continue;
          }

          // Plumbing: fold it and keep walking, unless it is a dead end.
          if (visited.has(target.id)) continue;
          if ((fanIn.get(target.id) ?? 0) >= HUB_THRESHOLD) {
            truncated.hubs++;
            continue;
          }
          if (meta.synthesizedBy === 'jsx-render' && isSharedChrome(cg, target, chromeParents)) {
            truncated.chrome++;
            continue;
          }
          if (visited.size >= MAX_FOLDED_PER_STEP) {
            step.cut = step.cut ?? 'folded';
            continue;
          }
          visited.add(target.id);
          const when = await whenAt(fold.node, { line: e.line, column: e.column });
          next.push({ node: target, chain: [...fold.chain, target], whens: [...fold.whens, when] });
        }
      }
      frontier = next;
    }
  }

  // An effect box with ONE call behind it says what that call passes —
  // `axios.post('/auth/login', { email, password })` is the fact a reader
  // scans for; several calls list themselves in the panel instead.
  const sitesByStep = new Map<string, WireStepSite[]>();
  for (const l of links.values()) {
    const list = sitesByStep.get(l.to) ?? [];
    list.push(...l.sites);
    sitesByStep.set(l.to, list);
  }
  for (const step of steps.values()) {
    if (step.kind !== 'effect' || !step.effect) continue;
    const sites = sitesByStep.get(step.id) ?? [];
    // A response box is the endpoint's contract: the status codes it can
    // send, when they are literal, are its label; the rows say when.
    if (step.effect.category === 'response') {
      const statuses = [...new Set(sites.map((s) => s.status).filter((x): x is number => typeof x === 'number'))].sort((a, b) => a - b);
      if (statuses.length > 0) {
        step.effect.statuses = statuses;
        step.label = statuses.join(' · ');
        continue;
      }
    }
    if (step.effect.apis.length !== 1) continue;
    if (sites.length !== 1 || sites[0]!.args === undefined) continue;
    const label = `${step.effect.api}(${sites[0]!.args})`;
    step.label = label.length > MAX_EFFECT_LABEL ? `${label.slice(0, MAX_EFFECT_LABEL - 2)}…)` : label;
  }

  const ordered = [...steps.values()].sort((a, b) => a.depth - b.depth || a.label.localeCompare(b.label) || a.id.localeCompare(b.id));
  return {
    anchor: toNodeRef(anchor),
    ambiguous,
    project,
    steps: ordered.map(({ root: _root, ...step }) => step),
    links: [...links.values()].sort((a, b) => a.id.localeCompare(b.id)),
    depth: depthCap,
    limit,
    through,
    truncated,
    index,
    timing: { elapsedMs: Date.now() - started },
  };
}

// =============================================================================
// Helpers
// =============================================================================

/**
 * The anchor: `anchor=<id>`, or `symbol=<name>` resolved to the most
 * screen-like symbol of that name — a route first, then a component or
 * function, then a method — with the rest reported as `ambiguous`.
 */
function resolveAnchor(cg: CodeGraph, query: URLSearchParams): { anchor: Node; ambiguous: WireNodeRef[] } {
  const id = query.get('anchor');
  if (id !== null && id.trim() !== '') {
    const node = cg.getNode(id);
    if (!node) throw notFound(`No symbol with id "${id}" in this index.`, 'It may have moved in a re-index; open it from search or the Screens view.');
    return { anchor: node, ambiguous: [] };
  }
  const name = query.get('symbol');
  if (name === null || name.trim() === '') throw badRequest('Give the picture an anchor: ?anchor=<node id> or ?symbol=<name>.');
  const rank: Record<string, number> = { route: 0, component: 1, function: 2, method: 3, class: 4, constant: 5, variable: 6 };
  const matches = cg
    .getNodesByName(name.trim())
    .filter((n) => n.kind !== 'file' && n.kind !== 'import' && n.kind !== 'export')
    .sort((a, b) => (rank[a.kind] ?? 9) - (rank[b.kind] ?? 9) || a.filePath.localeCompare(b.filePath) || a.startLine - b.startLine);
  const anchor = matches[0];
  if (!anchor) throw notFound(`Nothing in this index is named "${name}".`, 'Try the search box; names are matched exactly.');
  return { anchor, ambiguous: matches.slice(1, 9).map(toNodeRef) };
}

/** How many distinct parents render this node as a JSX child. Memoised per request. */
function renderParents(cg: CodeGraph, node: Node, memo: Map<string, number>): number {
  let parents = memo.get(node.id);
  if (parents === undefined) {
    const incoming = cg.getIncomingEdgesTo([node.id], ['calls']);
    const sources = new Set<string>();
    for (const e of incoming) {
      if ((e.metadata as Record<string, unknown> | undefined)?.synthesizedBy === 'jsx-render') sources.add(e.source);
    }
    parents = sources.size;
    memo.set(node.id, parents);
  }
  return parents;
}

/** A component rendered by several distinct parents is chrome. */
function isSharedChrome(cg: CodeGraph, component: Node, memo: Map<string, number>): boolean {
  return renderParents(cg, component, memo) >= SHARED_CHROME_MIN;
}

/**
 * What kind of project the picture is of, by what its routes are: endpoints
 * (`POST /users`) make an API; screens with navigation between them make an
 * app; both — pages and the endpoints behind them — make a web app.
 */
export function projectKind(routes: readonly Node[], navigates: number): 'app' | 'api' | 'web' {
  let endpoints = 0;
  let pages = 0;
  for (const r of routes) {
    if (splitRouteName(r.name).method !== null) endpoints++;
    else if (r.name.startsWith('/')) pages++;
  }
  if (endpoints === 0) return 'app';
  return navigates > 0 || pages > 0 ? 'web' : 'api';
}

function basename(p: string): string {
  const s = posix(p);
  return s.slice(s.lastIndexOf('/') + 1);
}

/**
 * Function-as-value references made at a file's top level within a node's
 * lines — what `const Memoized = memo(CaptureComponent)` leaves behind: the
 * reference belongs to the file scope, the wrapper node spans the line.
 */
function fileScopeFnRefsWithin(cg: CodeGraph, node: Node, memo: Map<string, Edge[]>): Edge[] {
  let refs = memo.get(node.filePath);
  if (refs === undefined) {
    const file = cg.getNodesInFile(node.filePath).find((n) => n.kind === 'file');
    refs = file
      ? cg.getOutgoingEdgesFrom([file.id], ['references']).filter((e) => (e.metadata as Record<string, unknown> | undefined)?.fnRef === true)
      : [];
    memo.set(node.filePath, refs);
  }
  return refs.filter((e) => typeof e.line === 'number' && e.line >= node.startLine && e.line <= node.endLine);
}

/** `push /capture`, `renders <Button>`, `via rn-event-channel`, `calls`. */
function siteText(edge: Edge, meta: Record<string, unknown>, target: Node): string {
  if (edge.kind === 'navigates') {
    const method = edge.provenance === 'heuristic' ? 'returns' : typeof meta.navMethod === 'string' ? meta.navMethod : 'push';
    return `${method} ${typeof meta.href === 'string' ? meta.href : target.name}`;
  }
  if (meta.synthesizedBy === 'jsx-render') return `renders <${target.name}>`;
  if (edge.kind === 'references') return `passes ${target.name}`;
  if (edge.kind === 'contains') return `defines ${target.name}`;
  if (edge.kind === 'instantiates') return `new ${target.name}`;
  if (meta.bridge === 'react-native') return `bridge ${typeof meta.module === 'string' ? meta.module + '.' : ''}${target.name}`;
  if (typeof meta.synthesizedBy === 'string') return `via ${meta.synthesizedBy}`;
  return `calls ${target.name}`;
}

/** The words on a hop that was not a plain call — the Flow strip's connector label, in short. */
function hopLabel(meta: Record<string, unknown>, synthesized: boolean): string {
  const parts: string[] = [];
  if (typeof meta.synthesizedBy === 'string') parts.push(`via ${meta.synthesizedBy}`);
  else if (synthesized) parts.push('inferred');
  if (meta.resolvedBy === 'receiver-type') parts.push('by the receiver’s declared type');
  if (typeof meta.event === 'string') parts.push(`event ${meta.event}`);
  if (meta.bridge === 'react-native') parts.push(`React Native bridge${typeof meta.module === 'string' ? ` · ${meta.module}` : ''}`);
  if (typeof meta.registeredAt === 'string') parts.push(`registered at ${meta.registeredAt}`);
  return parts.join(' · ');
}

function posix(p: string): string {
  return p.replace(/\\/g, '/');
}
