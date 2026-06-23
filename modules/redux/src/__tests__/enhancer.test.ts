import { describe, it, expect, vi } from "vitest";
import { computeShallowDiff, parseIngestUrl, rnDevReduxEnhancer } from "../../enhancer.js";

describe("computeShallowDiff", () => {
  it("detects replaced top-level slices by reference", () => {
    const auth1 = { id: "u1" };
    const auth2 = { id: "u2" };
    const ui = { theme: "dark" };
    const diff = computeShallowDiff({ auth: auth1, ui }, { auth: auth2, ui });
    // ui unchanged (same ref) → not in diff; auth replaced.
    expect(diff).toEqual([{ path: "auth", op: "replace", before: auth1, after: auth2 }]);
  });

  it("detects added + removed slices", () => {
    const diff = computeShallowDiff({ a: 1 }, { b: 2 });
    expect(diff).toContainEqual({ path: "a", op: "remove", before: 1 });
    expect(diff).toContainEqual({ path: "b", op: "add", after: 2 });
  });

  it("non-object roots compare by value", () => {
    expect(computeShallowDiff(1, 2)).toEqual([{ path: "", op: "replace", before: 1, after: 2 }]);
    expect(computeShallowDiff(5, 5)).toEqual([]);
  });
});

describe("parseIngestUrl", () => {
  it("derives ws://host:(port+offset) from a Metro scriptURL", () => {
    expect(parseIngestUrl("http://10.0.2.2:8081/index.bundle?platform=android&dev=true")).toBe(
      "ws://10.0.2.2:12081",
    );
    expect(parseIngestUrl("http://localhost:8090/index.bundle")).toBe("ws://localhost:12090");
  });

  it("honors a custom offset", () => {
    expect(parseIngestUrl("http://localhost:8081/x", 100)).toBe("ws://localhost:8181");
  });

  it("returns null for an unparseable URL", () => {
    expect(parseIngestUrl("not a url")).toBeNull();
  });
});

/**
 * Regression: after SOCKET_CONNECTION put a live WebSocket in state,
 * vanilla JSON.stringify threw on circular refs every subsequent
 * dispatch, the enhancer silently swallowed, and the panel went dark
 * after ~10 bootstrap actions. safeStringify() must not throw for
 * states containing live native objects.
 */
describe("rnDevReduxEnhancer — safeStringify keeps capture alive after live objects enter state", () => {
  function mkFakeWebSocket(): { send: ReturnType<typeof vi.fn>; close: ReturnType<typeof vi.fn>; onopen?: () => void; onclose?: () => void; onerror?: () => void } {
    return { send: vi.fn(), close: vi.fn() };
  }

  it("dispatches survive a circular state value (acme's WebSocket-in-state case)", () => {
    const ws = mkFakeWebSocket();
    // Stub global WebSocket and RN's scriptURL source so the enhancer
    // initializes its connection path. Then trigger onopen and verify
    // that ws.send sees frames AFTER a circular-state action.
    (globalThis as unknown as { WebSocket: unknown }).WebSocket = function FakeWS(_url: string) {
      Object.assign(this as object, ws);
      // open immediately on next tick
      setTimeout(() => ws.onopen?.(), 0);
      return ws;
    } as unknown as never;

    // Reducer: SOCKET_CONNECTION stashes a circular value (mirrors a
    // real WebSocket holding back-refs in its event-listener graph).
    interface State { count: number; socket?: object }
    const circular: { self?: unknown } = {};
    circular.self = circular;
    function reducer(state: State = { count: 0 }, action: { type: string }): State {
      if (action.type === "SOCKET_CONNECTION") return { ...state, socket: circular };
      if (action.type === "AFTER_SOCKET") return { ...state, count: state.count + 1 };
      return state;
    }

    const createStore: (r: typeof reducer) => { dispatch: (a: { type: string }) => void; getState: () => State; subscribe: () => () => void } = (r) => {
      let s = r(undefined as unknown as State, { type: "@@INIT" });
      const listeners: Array<() => void> = [];
      return {
        dispatch: (a) => { s = r(s, a); listeners.forEach((l) => l()); },
        getState: () => s,
        subscribe: (l: () => void) => { listeners.push(l); return () => { /* noop */ }; },
      };
    };

    const enhancer = rnDevReduxEnhancer({ url: "ws://test/" });
    const enhanced = enhancer(createStore as unknown as never);
    const store = enhanced(reducer);

    // Drive through the failure case
    store.dispatch({ type: "SOCKET_CONNECTION" });
    store.dispatch({ type: "AFTER_SOCKET" });
    store.dispatch({ type: "AFTER_SOCKET" });

    return new Promise<void>((resolve) => {
      // give onopen + flush a tick
      setTimeout(() => {
        // Pre-fix this would be 0 (every send dropped silently). Post-fix
        // we get the hello + INIT + 3 dispatched actions = 5 frames min.
        expect(ws.send.mock.calls.length).toBeGreaterThanOrEqual(5);
        // None of the sent frames is empty / undefined
        for (const call of ws.send.mock.calls) {
          expect(typeof call[0]).toBe("string");
          expect(call[0].length).toBeGreaterThan(0);
        }
        resolve();
      }, 20);
    });
  });
});
