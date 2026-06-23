/**
 * rn-dev Redux store enhancer — the app-side half of the redux module.
 *
 * Self-contained, ZERO dependencies (uses only RN globals). Vendor this
 * single file into the app and add it to the store enhancers in DEV:
 *
 *   import { rnDevReduxEnhancer } from './rn-dev-redux-enhancer'
 *   // legacy createStore:
 *   const enhancer = __DEV__ ? rnDevReduxEnhancer() : (x) => x
 *   const store = createStore(reducer, preloadedState, enhancer)
 *   // RTK:  configureStore({ reducer, enhancers: (def) => def().concat(...) })  // see README
 *
 * It opens a websocket to the rn-dev redux ingest (derived from the Metro
 * dev-server URL the app loaded from — `metroPort + REDUX_INGEST_PORT_OFFSET`)
 * and streams one frame per dispatched action: the action type, its
 * payload, a shallow state diff, and the full post-action state (so the
 * host's `redux__state` is always current). Best-effort and fail-open: any
 * error degrades to a no-op — the enhancer must NEVER break the app.
 *
 * Redaction happens HOST-SIDE (rn-dev applies the operator's black/white
 * list); this file sends raw, which is fine because the connection is the
 * dev machine's own loopback/LAN to the dev tool. For the most sensitive
 * shops, pass `redact` to strip values before they leave the device.
 */

// MUST match src/core/redux/ingest.ts REDUX_INGEST_PORT_OFFSET.
const REDUX_INGEST_PORT_OFFSET = 4000;
const ENHANCER_VERSION = "0.1.1";
const MAX_QUEUE = 200;
const RECONNECT_MS = 3000;

/**
 * Safe JSON stringifier — handles values that vanilla JSON.stringify
 * throws on (circular references, BigInt), and replaces common
 * non-serializable runtime objects with a placeholder so a single
 * dirty value can't silently lose every subsequent action frame.
 *
 * Why this exists: acme (and other apps) store live native objects
 * in their redux state — a `socket: WebSocket` slice is the canonical
 * case. After the first action that puts the live object in state,
 * vanilla JSON.stringify throws "Converting circular structure to JSON"
 * on every subsequent dispatch, the enhancer's send() catches and
 * silently returns, and the panel goes dark with no signal. This
 * stringifier guarantees the JSON serialization step never throws.
 */
function safeStringify(value: unknown): string {
  const seen = new WeakSet<object>();
  return JSON.stringify(value, (_key, v) => {
    if (typeof v === "bigint") return v.toString() + "n";
    if (typeof v === "function") return "[function]";
    if (typeof v === "object" && v !== null) {
      if (seen.has(v)) return "[circular]";
      seen.add(v);
      // Strip well-known non-plain native objects — replacing them with
      // a recognizable placeholder keeps the rest of the state shape
      // intact in the panel.
      const ctor = (v as { constructor?: { name?: string } }).constructor?.name;
      if (
        ctor === "WebSocket" ||
        ctor === "XMLHttpRequest" ||
        ctor === "Headers" ||
        ctor === "Request" ||
        ctor === "Response" ||
        ctor === "Blob" ||
        ctor === "FormData" ||
        ctor === "AbortController" ||
        ctor === "AbortSignal"
      ) {
        return `<${ctor}>`;
      }
      if (v instanceof Error) return { __error: v.message, name: v.name };
      if (typeof Map !== "undefined" && v instanceof Map) return Array.from(v.entries());
      if (typeof Set !== "undefined" && v instanceof Set) return Array.from(v.values());
    }
    return v;
  });
}

export interface ReduxEnhancerOptions {
  /** Full ws URL override. Else derived from the Metro scriptURL. */
  url?: string;
  /** Metro scriptURL override (else read from RN's SourceCode native module). */
  scriptURL?: string;
  /** Optional value transform applied before sending (enhancer-side redaction). */
  redact?: (value: unknown) => unknown;
}

export interface ShallowDiffEntry {
  path: string;
  op: "add" | "remove" | "replace";
  before?: unknown;
  after?: unknown;
}

/**
 * Shallow (top-level) state diff by reference equality — exactly how Redux
 * reducers signal change (a changed slice is a new object reference). Pure.
 */
export function computeShallowDiff(prev: unknown, next: unknown): ShallowDiffEntry[] {
  const out: ShallowDiffEntry[] = [];
  const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object";
  if (!isObj(prev) || !isObj(next)) {
    if (prev !== next) out.push({ path: "", op: "replace", before: prev, after: next });
    return out;
  }
  const keys = new Set([...Object.keys(prev), ...Object.keys(next)]);
  for (const k of keys) {
    const inPrev = k in prev;
    const inNext = k in next;
    if (inPrev && !inNext) out.push({ path: k, op: "remove", before: prev[k] });
    else if (!inPrev && inNext) out.push({ path: k, op: "add", after: next[k] });
    else if (prev[k] !== next[k]) out.push({ path: k, op: "replace", before: prev[k], after: next[k] });
  }
  return out;
}

/** Derive the ws ingest URL from a Metro http scriptURL. Pure. Null when unparseable. */
export function parseIngestUrl(scriptURL: string, offset: number = REDUX_INGEST_PORT_OFFSET): string | null {
  const m = scriptURL.match(/^https?:\/\/([^/:]+):(\d+)/i);
  if (!m) return null;
  const host = m[1];
  const port = parseInt(m[2]!, 10);
  if (!Number.isFinite(port)) return null;
  return `ws://${host}:${port + offset}`;
}

// RN runtime interop — these globals/modules only exist in the app bundle.
// Typed loose on purpose (this file is bundled by Metro, not the host tsc).
/* eslint-disable @typescript-eslint/no-explicit-any */
function rnScriptURL(): string | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const rn: any = require("react-native");
    const sc = rn?.NativeModules?.SourceCode;
    const url: unknown = sc?.getConstants?.().scriptURL ?? sc?.scriptURL;
    return typeof url === "string" ? url : null;
  } catch {
    return null;
  }
}

function resolveUrl(opts: ReduxEnhancerOptions): string | null {
  if (opts.url) return opts.url;
  const script = opts.scriptURL ?? rnScriptURL();
  return script ? parseIngestUrl(script) : null;
}

/**
 * The enhancer. Returns the standard Redux enhancer signature. Fail-open:
 * if anything is missing (no WebSocket, no dev-server URL, prod build) it
 * returns the store untouched.
 */
export function rnDevReduxEnhancer(opts: ReduxEnhancerOptions = {}) {
  return (createStore: any) =>
    (reducer: any, preloadedState?: any): any => {
      const store = createStore(reducer, preloadedState);
      const g: any = globalThis as any;
      // Hard no-op in production builds even if mistakenly wired.
      if (typeof g.__DEV__ !== "undefined" && g.__DEV__ === false) return store;
      const WSImpl: any = g.WebSocket;
      const url = resolveUrl(opts);
      if (!WSImpl || !url) return store;

      const redact = opts.redact ?? ((v: unknown) => v);
      let ws: any = null;
      let open = false;
      const queue: string[] = [];
      let disposed = false;

      const flush = (): void => {
        if (!open || !ws) return;
        while (queue.length > 0) {
          const f = queue.shift();
          try {
            ws.send(f);
          } catch {
            break;
          }
        }
      };
      const send = (frame: unknown): void => {
        let text: string;
        try {
          // safeStringify never throws — handles circular refs, BigInt,
          // and live native objects (WebSocket etc.) that would silently
          // drop every action after the first time they enter state.
          text = safeStringify(frame);
        } catch (err) {
          // Even with safeStringify this branch should be unreachable;
          // we log it instead of silently swallowing so future
          // serialization regressions are visible. RN's console.warn
          // surfaces in Metro logs.
          try {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const g: any = globalThis;
            g.console?.warn?.("[rn-dev redux enhancer] frame stringify failed:", String(err));
          } catch { /* ignore */ }
          return;
        }
        if (open && ws) {
          try {
            ws.send(text);
            return;
          } catch {
            /* fall through to queue */
          }
        }
        if (queue.length < MAX_QUEUE) queue.push(text);
      };

      const connect = (): void => {
        if (disposed) return;
        try {
          ws = new WSImpl(url);
        } catch {
          return;
        }
        ws.onopen = (): void => {
          open = true;
          send({ t: "hello", enhancerVersion: ENHANCER_VERSION });
          // Seed the host with the current full state so redux__state is
          // immediately populated (epoch already bumped by `hello`).
          send({ t: "action", type: "@@rn-dev/INIT", payload: null, diff: [], stateAfter: redact(store.getState()) });
          flush();
        };
        ws.onclose = (): void => {
          open = false;
          ws = null;
          if (!disposed) setTimeout(connect, RECONNECT_MS);
        };
        ws.onerror = (): void => {
          try {
            ws && ws.close();
          } catch {
            /* ignore */
          }
        };
      };
      connect();

      const rawDispatch = store.dispatch;
      const dispatch = (action: any): any => {
        const prev = store.getState();
        const result = rawDispatch(action);
        const next = store.getState();
        try {
          const { type, ...payload } = action ?? {};
          send({
            t: "action",
            type: typeof type === "string" ? type : String(type),
            payload: redact(payload),
            diff: redact(computeShallowDiff(prev, next)),
            stateAfter: redact(next),
          });
        } catch {
          /* never let capture break dispatch */
        }
        return result;
      };

      return { ...store, dispatch };
    };
}
