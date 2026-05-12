import { describe, it, expect } from "vitest";
import {
  requireSessionId,
  optionalSessionId,
  requireProfile,
  optionalProfile,
  parseEventsSubscribeInput,
  RpcArgError,
} from "../rpc-args.js";
import type { Profile } from "../../core/types.js";

const validProfilePayload: Profile = {
  name: "iphone-physical",
  isDefault: false,
  worktree: null,
  branch: "main",
  platform: "ios",
  mode: "quick",
  metroPort: 8081,
  devices: { ios: null, android: null },
  buildVariant: "debug",
  preflight: { checks: [], frequency: "once" },
  onSave: [],
  env: {},
  projectRoot: "/abs/project",
};

describe("requireSessionId", () => {
  it("returns the SessionId when present and non-empty", () => {
    const sid = requireSessionId({ sessionId: "abc" }, "ctx");
    expect(sid).toBe("abc");
  });

  it("throws RpcArgError when sessionId is missing", () => {
    expect(() => requireSessionId({}, "session/stop")).toThrowError(
      /session\/stop: sessionId required/,
    );
    const err = catchError(() => requireSessionId({}, "session/stop"));
    expect(err).toBeInstanceOf(RpcArgError);
    expect((err as RpcArgError).code).toBe("E_RPC_INVALID_PAYLOAD");
  });

  it("throws when sessionId is empty string", () => {
    expect(() =>
      requireSessionId({ sessionId: "" }, "ctx"),
    ).toThrowError(/required/);
  });

  it("throws when sessionId is not a string", () => {
    expect(() =>
      requireSessionId({ sessionId: 42 }, "ctx"),
    ).toThrowError(/required/);
    expect(() =>
      requireSessionId({ sessionId: null }, "ctx"),
    ).toThrowError(/required/);
  });

  it("throws when payload is not an object", () => {
    expect(() => requireSessionId(null, "ctx")).toThrowError(/required/);
    expect(() => requireSessionId("string", "ctx")).toThrowError(/required/);
    expect(() => requireSessionId(undefined, "ctx")).toThrowError(/required/);
  });
});

describe("optionalSessionId", () => {
  it("returns undefined when sessionId is absent", () => {
    expect(optionalSessionId({})).toBeUndefined();
    expect(optionalSessionId(null)).toBeUndefined();
    expect(optionalSessionId({ sessionId: "" })).toBeUndefined();
    expect(optionalSessionId({ sessionId: 42 })).toBeUndefined();
  });

  it("returns the SessionId when present and non-empty", () => {
    expect(optionalSessionId({ sessionId: "abc" })).toBe("abc");
  });
});

describe("requireProfile", () => {
  it("returns ValidatedProfile when present and valid", () => {
    const p = requireProfile(
      { profile: validProfilePayload },
      "session/start",
    );
    expect(p.name).toBe("iphone-physical");
  });

  it("throws with the validator's specific error code when profile is malformed", () => {
    const err = catchError(() =>
      requireProfile(
        { profile: { ...validProfilePayload, metroPort: -1 } },
        "session/start",
      ),
    );
    expect(err).toBeInstanceOf(RpcArgError);
    expect((err as RpcArgError).code).toBe("E_PROFILE_METRO_PORT");
  });

  it("throws E_RPC_INVALID_PAYLOAD when payload is not an object", () => {
    const err = catchError(() => requireProfile(null, "session/start"));
    expect((err as RpcArgError).code).toBe("E_RPC_INVALID_PAYLOAD");
  });
});

describe("optionalProfile", () => {
  it("returns undefined when absent", () => {
    expect(optionalProfile({}, "ctx")).toBeUndefined();
    expect(optionalProfile({ profile: null }, "ctx")).toBeUndefined();
  });

  it("returns ValidatedProfile when present and valid", () => {
    const p = optionalProfile({ profile: validProfilePayload }, "ctx");
    expect(p?.name).toBe("iphone-physical");
  });

  it("throws (not returns undefined) when a profile-shaped value is malformed", () => {
    const err = catchError(() =>
      optionalProfile(
        { profile: { ...validProfilePayload, name: "" } },
        "ctx",
      ),
    );
    expect((err as RpcArgError).code).toBe("E_PROFILE_NAME");
  });
});

describe("parseEventsSubscribeInput", () => {
  it("returns boot-or-join mode when only profile is present", () => {
    const r = parseEventsSubscribeInput(
      { profile: validProfilePayload },
      "events/subscribe",
    );
    expect(r.mode).toBe("boot-or-join");
    if (r.mode === "boot-or-join") {
      expect(r.profile.name).toBe("iphone-physical");
    }
  });

  it("returns attach-by-id mode when only sessionId is present", () => {
    const r = parseEventsSubscribeInput(
      { sessionId: "sid-123" },
      "events/subscribe",
    );
    expect(r.mode).toBe("attach-by-id");
    if (r.mode === "attach-by-id") {
      expect(r.sessionId).toBe("sid-123");
    }
  });

  it("rejects both fields present", () => {
    const err = catchError(() =>
      parseEventsSubscribeInput(
        { profile: validProfilePayload, sessionId: "sid-1" },
        "events/subscribe",
      ),
    );
    expect((err as RpcArgError).code).toBe("E_SUBSCRIBE_INVALID_ARGS");
    expect((err as Error).message).toMatch(/not both/);
  });

  it("rejects neither field present (observer mode is replaced by sessions/list per plan § B2)", () => {
    const err = catchError(() =>
      parseEventsSubscribeInput({}, "events/subscribe"),
    );
    expect((err as RpcArgError).code).toBe("E_SUBSCRIBE_INVALID_ARGS");
    expect((err as Error).message).toMatch(/profile.*sessionId/);
  });

  it("propagates the profile validator's error code on malformed profile", () => {
    const err = catchError(() =>
      parseEventsSubscribeInput(
        { profile: { ...validProfilePayload, metroPort: 70000 } },
        "events/subscribe",
      ),
    );
    expect((err as RpcArgError).code).toBe("E_PROFILE_METRO_PORT");
  });

  it("rejects empty-string sessionId (treated as absent → no-field error)", () => {
    const err = catchError(() =>
      parseEventsSubscribeInput({ sessionId: "" }, "events/subscribe"),
    );
    expect((err as RpcArgError).code).toBe("E_SUBSCRIBE_INVALID_ARGS");
  });
});

function catchError(fn: () => unknown): unknown {
  try {
    fn();
    throw new Error("expected throw");
  } catch (e) {
    return e;
  }
}
