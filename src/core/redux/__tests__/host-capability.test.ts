import { describe, it, expect } from "vitest";
import { ReduxStore } from "../buffer.js";
import { REDACTED } from "../redact.js";
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

  it("redacts by DEFAULT (no config) — structure-only state + blacklisted leaves gone", async () => {
    const { store, cap } = setup();
    store.append(WK, {
      type: "auth/login",
      payload: { userId: "u1", authToken: "secret" },
      stateAfter: { auth: { userId: "u1", authToken: "secret" }, ui: { theme: "dark" } },
    });

    // State: structure-only by default; the blacklisted token is gone, not typed.
    const state = await cap.getState({});
    expect(state.value).toEqual({
      auth: { userId: "<string>", authToken: REDACTED },
      ui: { theme: "<string>" },
    });

    // Action payload: same default — structure-only + blacklist.
    const list = await cap.listActions({});
    expect(list.entries[0]!.payload).toEqual({ userId: "<string>", authToken: REDACTED });
    // Action TYPE is never redacted (it's the action name, not data).
    expect(list.entries[0]!.type).toBe("auth/login");
  });

  it("whitelist reveals a slice in full; blacklist still bites inside it", async () => {
    const { store, cap } = setup();
    store.append(WK, {
      type: "INIT",
      stateAfter: { ui: { theme: "dark", authToken: "x" }, auth: { id: "u1" } },
    });
    const state = await cap.getState({ redaction: { whitelist: ["ui"] } });
    expect(state.value).toEqual({
      ui: { theme: "dark", authToken: REDACTED }, // revealed, but token still redacted
      auth: { id: "<string>" }, // not whitelisted → structure-only
    });
  });

  it("reading a sub-path evaluates whitelist against the FULL path", async () => {
    const { store, cap } = setup();
    store.append(WK, { type: "INIT", stateAfter: { auth: { session: { token: "t", region: "us" } } } });
    // Whitelist auth.session, read it directly: region revealed, token blacklisted.
    const r = await cap.getState({ path: "auth.session", redaction: { whitelist: ["auth.session"] } });
    expect(r.value).toEqual({ token: REDACTED, region: "us" });
  });

  it("extraBlacklist EXTENDS the default (never replaces)", async () => {
    const { store, cap } = setup();
    store.append(WK, { type: "INIT", stateAfter: { profile: { accountCode: "D1", authToken: "x" } } });
    const r = await cap.getState({ redaction: { whitelist: ["profile"], extraBlacklist: ["*accountcode*"] } });
    // accountCode hit by the extra pattern; authToken still hit by the default.
    expect(r.value).toEqual({ profile: { accountCode: REDACTED, authToken: REDACTED } });
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
    const list = await cap.listActions({ worktreeKey: "someone-elses-wk" });
    expect(list.entries.map((e) => e.type)).toEqual(["MINE"]);
  });
});
