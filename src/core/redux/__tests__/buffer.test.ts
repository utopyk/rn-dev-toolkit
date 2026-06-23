import { describe, it, expect } from "vitest";
import {
  DEFAULT_BUFFER_CAPACITY,
  MAX_LIST_LIMIT,
  MAX_VALUE_BYTES,
  ReduxStore,
  navigatePath,
} from "../buffer.js";

const S = "sess-1";

describe("ReduxStore — append + listActions", () => {
  it("fresh session is empty", () => {
    const store = new ReduxStore();
    const status = store.status(S);
    expect(status.bufferSize).toBe(0);
    expect(status.bufferCapacity).toBe(DEFAULT_BUFFER_CAPACITY);
    expect(status.meta.bufferEpoch).toBe(1);
    expect(status.meta.oldestSequence).toBe(0);
    expect(status.meta.lastEventSequence).toBe(0);
    expect(status.meta.hasState).toBe(false);
  });

  it("assigns monotonic sequences from 1 and preserves order", () => {
    const store = new ReduxStore();
    const a = store.append(S, { type: "A" });
    const b = store.append(S, { type: "B" });
    expect(a.sequence).toBe(1);
    expect(b.sequence).toBe(2);
    const { entries, meta } = store.listActions(S);
    expect(entries.map((e) => e.type)).toEqual(["A", "B"]);
    expect(meta.lastEventSequence).toBe(2);
    expect(meta.totalActionsReceived).toBe(2);
  });

  it("evicts oldest past capacity and counts evictions", () => {
    const store = new ReduxStore({ capacity: 3 });
    for (let i = 0; i < 5; i++) store.append(S, { type: `T${i}` });
    const { entries, meta } = store.listActions(S);
    expect(entries.map((e) => e.type)).toEqual(["T2", "T3", "T4"]);
    expect(meta.evictedCount).toBe(2);
    expect(meta.oldestSequence).toBe(3);
    expect(meta.totalActionsReceived).toBe(5);
  });

  it("typeFilter is case-insensitive substring on the action type", () => {
    const store = new ReduxStore();
    store.append(S, { type: "auth/login" });
    store.append(S, { type: "conversations/fetch" });
    store.append(S, { type: "auth/logout" });
    const { entries } = store.listActions(S, { typeFilter: "AUTH" });
    expect(entries.map((e) => e.type)).toEqual(["auth/login", "auth/logout"]);
  });

  it("since cursor returns only newer actions; advances to last returned", () => {
    const store = new ReduxStore();
    store.append(S, { type: "A" });
    store.append(S, { type: "B" });
    const first = store.listActions(S);
    store.append(S, { type: "C" });
    const next = store.listActions(S, {
      since: { bufferEpoch: first.meta.bufferEpoch, sequence: first.meta.lastEventSequence },
    });
    expect(next.entries.map((e) => e.type)).toEqual(["C"]);
    expect(next.cursorDropped).toBe(false);
  });

  it("flags cursorDropped when the epoch bumped (clear)", () => {
    const store = new ReduxStore();
    store.append(S, { type: "A" });
    const snap = store.listActions(S);
    store.clear(S);
    store.append(S, { type: "B" });
    const after = store.listActions(S, {
      since: { bufferEpoch: snap.meta.bufferEpoch, sequence: snap.meta.lastEventSequence },
    });
    expect(after.cursorDropped).toBe(true);
    // Sequence stays monotonic across clear (not reset).
    expect(after.entries[0]!.sequence).toBe(2);
  });

  it("clamps limit to MAX_LIST_LIMIT", () => {
    const store = new ReduxStore({ capacity: MAX_LIST_LIMIT + 50 });
    for (let i = 0; i < MAX_LIST_LIMIT + 10; i++) store.append(S, { type: "X" });
    expect(store.listActions(S, { limit: 999999 }).entries.length).toBe(MAX_LIST_LIMIT);
  });

  it("getAction finds by sequence", () => {
    const store = new ReduxStore();
    store.append(S, { type: "A" });
    const b = store.append(S, { type: "B", payload: { n: 2 } });
    expect(store.getAction(S, b.sequence)?.type).toBe("B");
    expect(store.getAction(S, 999)).toBeNull();
  });
});

describe("ReduxStore — state snapshot", () => {
  it("present=false until a frame carries stateAfter", () => {
    const store = new ReduxStore();
    store.append(S, { type: "A" }); // no stateAfter
    const r = store.getState(S);
    expect(r.present).toBe(false);
    expect(r.meta.hasState).toBe(false);
  });

  it("keeps the latest snapshot and navigates by path", () => {
    const store = new ReduxStore();
    store.append(S, { type: "INIT", stateAfter: { auth: { user: { id: "u1" } }, ui: { theme: "dark" } } });
    expect(store.getState(S, "ui.theme").value).toBe("dark");
    expect(store.getState(S, "auth.user.id").value).toBe("u1");
    expect(store.getState(S).present).toBe(true);
  });

  it("missing path → present=false, not a thrown error", () => {
    const store = new ReduxStore();
    store.append(S, { type: "INIT", stateAfter: { a: 1 } });
    const r = store.getState(S, "a.b.c");
    expect(r.present).toBe(false);
    expect(r.value).toBeNull();
  });

  it("clear() drops state + actions and bumps epoch", () => {
    const store = new ReduxStore();
    store.append(S, { type: "A", stateAfter: { x: 1 } });
    const meta = store.clear(S);
    expect(meta.bufferEpoch).toBe(2);
    expect(store.getState(S).present).toBe(false);
    expect(store.size(S)).toBe(0);
  });
});

describe("ReduxStore — size caps + isolation", () => {
  it("replaces an oversized payload with a marker and counts it", () => {
    const store = new ReduxStore();
    const huge = "x".repeat(MAX_VALUE_BYTES + 10);
    store.append(S, { type: "BIG", payload: huge });
    const { entries, meta } = store.listActions(S);
    expect(String(entries[0]!.payload)).toMatch(/^<oversized:\d+bytes>$/);
    expect(meta.truncatedCount).toBe(1);
  });

  it("handles a non-serializable (circular) payload without throwing", () => {
    const store = new ReduxStore();
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    store.append(S, { type: "CYC", payload: circular });
    expect(store.listActions(S).entries[0]!.payload).toBe("<unserializable>");
  });

  it("sessions are isolated (no cross-talk)", () => {
    const store = new ReduxStore();
    store.append("a", { type: "A" });
    store.append("b", { type: "B1" });
    store.append("b", { type: "B2" });
    expect(store.size("a")).toBe(1);
    expect(store.size("b")).toBe(2);
    expect(store.listActions("a").entries.map((e) => e.type)).toEqual(["A"]);
  });

  it("when whole state is oversized, only the oversized SLICES get the marker (per-slice cap)", () => {
    // Regression: acme's redux state ran ~290 KB total. Wholesale
    // capValue() replaced the entire tree with one marker, killing the
    // panel's view of every other slice. Per-slice cap keeps small
    // slices visible.
    const store = new ReduxStore();
    const fatSlice = "x".repeat(MAX_VALUE_BYTES + 10); // pushes total over cap
    store.append(S, {
      type: "INIT",
      stateAfter: {
        auth: { user: "u1" },          // small, must remain raw
        ui: { theme: "dark" },         // small
        entities: fatSlice,            // oversized → marker
        flags: { beta: true },         // small
      },
    });
    const stateAfter = store.getState(S).value as Record<string, unknown>;
    expect(stateAfter.auth).toEqual({ user: "u1" });
    expect(stateAfter.ui).toEqual({ theme: "dark" });
    expect(stateAfter.flags).toEqual({ beta: true });
    expect(String(stateAfter.entities)).toMatch(/^<oversized:\d+bytes>$/);
    // truncatedCount tracks SLICES truncated for the state path
    expect(store.listActions(S).meta.truncatedCount).toBe(1);
  });

  it("state that fits as a whole is stored raw (per-slice cap is no-op)", () => {
    const store = new ReduxStore();
    store.append(S, {
      type: "INIT",
      stateAfter: { auth: { user: "u1" }, ui: { theme: "dark" } },
    });
    const s = store.getState(S).value;
    expect(s).toEqual({ auth: { user: "u1" }, ui: { theme: "dark" } });
    expect(store.listActions(S).meta.truncatedCount).toBe(0);
  });

  it("non-object oversized state (huge string at root) still gets the wholesale marker", () => {
    // Per-slice descent only makes sense for plain objects. An array
    // or primitive that's oversized has nothing to drill into.
    const store = new ReduxStore();
    store.append(S, { type: "BIG", stateAfter: "x".repeat(MAX_VALUE_BYTES + 10) });
    expect(String(store.getState(S).value)).toMatch(/^<oversized:\d+bytes>$/);
  });

  it("when a diff entry's before/after is oversized, only THAT entry's values get the marker — array shape survives", () => {
    // Regression: acme's `roDetail/fetchRepairOrderDetail/fulfilled`
    // action had a diff entry whose `before`+`after` pair was ~580 KB
    // (the slice itself ran ~290 KB). Wholesale `capValue(frame.diff)`
    // replaced the whole array with `<oversized:Nbytes>` (a STRING),
    // the panel's `Array.isArray(diff)` check fell through, and it
    // rendered "No state changes for this action" — confusing the user
    // about whether the action did anything. Per-entry cap keeps the
    // array intact so path + op still render.
    const store = new ReduxStore();
    const fatSlice = "x".repeat(MAX_VALUE_BYTES + 10);
    store.append(S, {
      type: "roDetail/fetchRepairOrderDetail/fulfilled",
      diff: [
        { path: "roDetail", op: "replace", before: { id: "1" }, after: fatSlice },
        { path: "ui", op: "replace", before: { theme: "dark" }, after: { theme: "light" } },
      ],
    });
    const action = store.listActions(S).entries[0]!;
    expect(Array.isArray(action.diff)).toBe(true);
    const diff = action.diff as Array<Record<string, unknown>>;
    expect(diff).toHaveLength(2);
    // First entry: `after` was huge → only `after` becomes a marker
    expect(diff[0]!.path).toBe("roDetail");
    expect(diff[0]!.op).toBe("replace");
    expect(diff[0]!.before).toEqual({ id: "1" });
    expect(String(diff[0]!.after)).toMatch(/^<oversized:\d+bytes>$/);
    // Second entry: both sides small → both stay raw
    expect(diff[1]!.before).toEqual({ theme: "dark" });
    expect(diff[1]!.after).toEqual({ theme: "light" });
    // truncatedCount counts truncated diff ENTRIES
    expect(store.listActions(S).meta.truncatedCount).toBe(1);
  });

  it("diff that fits as a whole is stored raw (per-entry cap is no-op)", () => {
    const store = new ReduxStore();
    store.append(S, {
      type: "ui/setTheme",
      diff: [{ path: "ui", op: "replace", before: { theme: "dark" }, after: { theme: "light" } }],
    });
    expect(store.listActions(S).entries[0]!.diff).toEqual([
      { path: "ui", op: "replace", before: { theme: "dark" }, after: { theme: "light" } },
    ]);
    expect(store.listActions(S).meta.truncatedCount).toBe(0);
  });

  it("non-array oversized diff still gets the wholesale marker", () => {
    // A diff that arrives as a non-array (an enhancer redactor that
    // returned a string, say) has nothing to descend into and should
    // surface the same wholesale marker `capValue` produces.
    const store = new ReduxStore();
    store.append(S, { type: "WEIRD", diff: "x".repeat(MAX_VALUE_BYTES + 10) });
    expect(String(store.listActions(S).entries[0]!.diff)).toMatch(/^<oversized:\d+bytes>$/);
  });
});

describe("navigatePath", () => {
  it("empty path returns the whole tree", () => {
    expect(navigatePath({ a: 1 }, "").value).toEqual({ a: 1 });
  });
  it("dot + bracket indexing", () => {
    const root = { routes: [{ name: "Home" }, { name: "Profile" }] };
    expect(navigatePath(root, "routes[1].name").value).toBe("Profile");
  });
  it("missing key → present=false", () => {
    expect(navigatePath({ a: 1 }, "b").present).toBe(false);
  });
});
