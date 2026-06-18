import { describe, it, expect } from "vitest";
import { ReduxStore } from "../buffer.js";
import {
  createReduxHostCapability,
  REDUX_CAPABILITY_ID,
  REDUX_METHOD_PERMISSIONS,
} from "../host-capability.js";

const WK = "wk-default";

function setup() {
  const store = new ReduxStore();
  const cap = createReduxHostCapability(store, WK);
  return { store, cap };
}

describe("createReduxHostCapability", () => {
  it("exposes the capability id + per-method permissions (read vs mutate)", () => {
    expect(REDUX_CAPABILITY_ID).toBe("redux");
    expect(REDUX_METHOD_PERMISSIONS.status).toBe("redux:read");
    expect(REDUX_METHOD_PERMISSIONS.getState).toBe("redux:read");
    expect(REDUX_METHOD_PERMISSIONS.clear).toBe("redux:mutate");
  });

  it("returns raw store data through status/listActions/getState/getAction", async () => {
    const { store, cap } = setup();
    store.append(WK, { type: "auth/login", payload: { token: "secret" }, stateAfter: { auth: { token: "secret" } } });

    expect((await cap.status()).bufferSize).toBe(1);

    const list = await cap.listActions({});
    expect(list.entries[0]!.type).toBe("auth/login");
    // RAW — redaction is the module dto's job, not the capability's.
    expect(list.entries[0]!.payload).toEqual({ token: "secret" });

    const state = await cap.getState({ path: "auth.token" });
    expect(state.value).toBe("secret");

    const got = await cap.getAction({ sequence: list.entries[0]!.sequence });
    expect(got.action?.type).toBe("auth/login");
  });

  it("clear() drops the ring + bumps the epoch", async () => {
    const { store, cap } = setup();
    store.append(WK, { type: "A" });
    const res = await cap.clear({});
    expect(res.status).toBe("cleared");
    expect(res.meta.bufferEpoch).toBe(2);
    expect((await cap.status()).bufferSize).toBe(0);
  });

  it("coerces an unknown worktreeKey to the session default (scoping guard)", async () => {
    const { store, cap } = setup();
    store.append(WK, { type: "MINE" });
    // A caller asking for a worktree it wasn't granted resolves to the
    // default rather than reading/creating a foreign slice.
    const list = await cap.listActions({ worktreeKey: "someone-elses-wk" });
    expect(list.entries.map((e) => e.type)).toEqual(["MINE"]);
  });
});
