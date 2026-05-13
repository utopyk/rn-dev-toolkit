// Phase D5 — verify that ServiceBus events carry a `sessionId` and that a
// subscriber can distinguish between concurrent sessions by reading the
// tag. v1 TUI ignores sessionId (single-session behavior), but the
// daemon multi-session arc (D6/D7) needs the bus to carry the
// discriminator so renderer-side filters are mechanical from here on.
//
// The integration layer (real subprocess + real daemon) for ServiceBus
// payload shape is covered by `electron/__tests__/daemon-connect.test.ts`,
// which now also asserts the emitted sessionId matches `session.sessionId`.
// This file is the fast in-process test layer per
// `memory/feedback_test_parity_no_gaps.md`.
import { describe, expect, it } from "vitest";
import { serviceBus } from "../service-bus.js";
import { asSessionId, type SessionId } from "../../core/identifiers.js";
import type { MetroClient } from "../client/metro-adapter.js";
import type { BuilderClient } from "../client/builder-adapter.js";
import type { DevToolsClient } from "../client/devtools-adapter.js";

// Synthetic adapters — we never call into them; the bus just hands the
// reference through, so the test only needs object identity.
function fakeMetro(): MetroClient {
  return {} as MetroClient;
}
function fakeBuilder(): BuilderClient {
  return {} as BuilderClient;
}
function fakeDevTools(): DevToolsClient {
  return {} as DevToolsClient;
}

describe("ServiceBus multi-session payloads", () => {
  it("tags every metro emit with the originating sessionId", () => {
    const sidA = asSessionId("session-A");
    const sidB = asSessionId("session-B");
    const metroA = fakeMetro();
    const metroB = fakeMetro();

    const received: Array<{ sessionId: SessionId; metro: MetroClient }> = [];
    const handler = (payload: { sessionId: SessionId; metro: MetroClient }) => {
      received.push(payload);
    };
    serviceBus.on("metro", handler);

    try {
      serviceBus.setMetro(sidA, metroA);
      serviceBus.setMetro(sidB, metroB);

      expect(received).toHaveLength(2);
      expect(received[0]?.sessionId).toBe(sidA);
      expect(received[0]?.metro).toBe(metroA);
      expect(received[1]?.sessionId).toBe(sidB);
      expect(received[1]?.metro).toBe(metroB);
    } finally {
      serviceBus.off("metro", handler);
    }
  });

  it("lets a subscriber filter to a single session by sessionId", () => {
    const sidA = asSessionId("filter-A");
    const sidB = asSessionId("filter-B");
    const builderA = fakeBuilder();
    const builderB = fakeBuilder();

    const onlyA: BuilderClient[] = [];
    const handler = ({
      sessionId,
      builder,
    }: {
      sessionId: SessionId;
      builder: BuilderClient;
    }) => {
      if (sessionId === sidA) onlyA.push(builder);
    };
    serviceBus.on("builder", handler);

    try {
      serviceBus.setBuilder(sidB, builderB);
      serviceBus.setBuilder(sidA, builderA);
      serviceBus.setBuilder(sidB, builderB);

      expect(onlyA).toEqual([builderA]);
    } finally {
      serviceBus.off("builder", handler);
    }
  });

  it("carries sessionId on devtools, worktreeKey, and modulesClient topics", () => {
    const sid = asSessionId("topic-coverage");
    const devtools = fakeDevTools();

    const seen: Record<string, { sessionId: SessionId | null }> = {};
    const onDevTools = (payload: { sessionId: SessionId; devtools: DevToolsClient }) => {
      seen.devtools = { sessionId: payload.sessionId };
    };
    const onWorktree = (payload: { sessionId: SessionId; worktreeKey: string }) => {
      seen.worktreeKey = { sessionId: payload.sessionId };
    };
    const onModules = (payload: { sessionId: SessionId | null }) => {
      seen.modulesClient = { sessionId: payload.sessionId };
    };

    serviceBus.on("devtools", onDevTools);
    serviceBus.on("worktreeKey", onWorktree);
    serviceBus.on("modulesClient", onModules);

    try {
      serviceBus.setDevTools(sid, devtools);
      serviceBus.setWorktreeKey(sid, "wt-key-hash");
      serviceBus.clearModulesClient();

      expect(seen.devtools?.sessionId).toBe(sid);
      expect(seen.worktreeKey?.sessionId).toBe(sid);
      // `clearModulesClient` deliberately emits with `sessionId: null` —
      // the daemon disconnect that triggers it is cross-session by
      // construction.
      expect(seen.modulesClient?.sessionId).toBeNull();
    } finally {
      serviceBus.off("devtools", onDevTools);
      serviceBus.off("worktreeKey", onWorktree);
      serviceBus.off("modulesClient", onModules);
    }
  });

  it("emits log with null sessionId when called pre-session", () => {
    const captured: Array<{ sessionId: SessionId | null; text: string }> = [];
    const handler = (payload: { sessionId: SessionId | null; text: string }) => {
      captured.push(payload);
    };
    serviceBus.on("log", handler);

    try {
      // Cold-spawn-error style: no session bound yet.
      serviceBus.log("daemon connect failed");
      // Session-tagged: daemon-emitted lifecycle log.
      const sid = asSessionId("log-session");
      serviceBus.log("[daemon] booted", sid);

      expect(captured).toEqual([
        { sessionId: null, text: "daemon connect failed" },
        { sessionId: sid, text: "[daemon] booted" },
      ]);
    } finally {
      serviceBus.off("log", handler);
    }
  });
});
