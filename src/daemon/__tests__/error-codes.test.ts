import { describe, it, expectTypeOf } from "vitest";
import type {
  SessionErrorCode,
  RpcResult,
  SessionAmbiguousData,
} from "../error-codes.js";

describe("SessionErrorCode union", () => {
  it("accepts every documented code at compile time", () => {
    function takesCode(_c: SessionErrorCode): void {
      /* noop */
    }
    // Pre-existing codes.
    takesCode("E_PROFILE_MISMATCH");
    takesCode("E_SESSION_ALREADY_RUNNING");
    takesCode("E_SESSION_NOT_RUNNING");
    takesCode("E_SESSION_STOPPING");
    takesCode("E_RPC_FAILED");
    takesCode("E_RPC_INVALID_PAYLOAD");
    takesCode("E_RPC_NOT_AUTHORIZED");
    takesCode("E_UNKNOWN_ACTION");
    takesCode("E_SUBSCRIBE_INVALID_KINDS");
    takesCode("E_HOOK_FAILED");
    // Multi-session additions.
    takesCode("E_UNKNOWN_SESSION");
    takesCode("E_SESSION_ALREADY_EXISTS");
    takesCode("E_SESSION_AMBIGUOUS");
    takesCode("E_PORT_CONFLICT");
    takesCode("E_PROFILE_BOOT_IN_FLIGHT");
    takesCode("E_SUBSCRIBE_INVALID_ARGS");
  });

  it("rejects unknown codes at compile time", () => {
    function takesCode(_c: SessionErrorCode): void { /* noop */ }
    // @ts-expect-error — code not in the union.
    takesCode("E_NOT_IN_UNION");
    // @ts-expect-error — wrong case.
    takesCode("e_unknown_session");
  });
});

describe("RpcResult<T>", () => {
  it("narrows on kind discriminator", () => {
    const ok: RpcResult<number> = { kind: "ok", value: 42 };
    const err: RpcResult<number> = {
      kind: "error",
      code: "E_UNKNOWN_SESSION",
      message: "...",
    };
    if (ok.kind === "ok") {
      expectTypeOf(ok.value).toEqualTypeOf<number>();
    }
    if (err.kind === "error") {
      expectTypeOf(err.code).toEqualTypeOf<SessionErrorCode>();
      expectTypeOf(err.message).toEqualTypeOf<string>();
    }
  });
});

describe("SessionAmbiguousData", () => {
  it("matches the expected shape from plan § B2", () => {
    const data: SessionAmbiguousData = {
      availableSessions: [
        { sessionId: "abc", profileName: "iphone" },
        { sessionId: "def", profileName: "android" },
      ],
    };
    expectTypeOf(data.availableSessions).toEqualTypeOf<
      ReadonlyArray<{ sessionId: string; profileName: string }>
    >();
  });
});
