/**
 * Post-install auto-bundler wiring in the Builder.
 *
 * After a successful Android device debug build, the Builder points the
 * device at the daemon's Metro over Wi-Fi (so a USB blip doesn't drop the
 * adb-reverse tunnel). This pins:
 *   - it fires for android + deviceId + success, with the package the RN
 *     CLI launch step reported (`am start ... cmp=<pkg>/`) and the build port;
 *   - it's skipped for iOS, no-device, opt-out, failed builds, and when no
 *     launch line was captured (with a visible "skipped" line in the latter);
 *   - the build's `done`/resolver are never blocked by it (detached).
 *
 * Drives a fake child_process so no gradle/adb is spawned. The stdout is a
 * real EventEmitter the test pushes data through, so the package-capture
 * regex runs against streamed output exactly as in production.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { EventEmitter } from "node:events";
import { Builder, type AutoBundlerFn } from "../builder.js";

interface FakeProc extends EventEmitter {
  pid: number;
  stdout: EventEmitter;
  stderr: EventEmitter;
  exitCode: number | null;
  kill: ReturnType<typeof vi.fn>;
  unref?: ReturnType<typeof vi.fn>;
}

const activeProcs: FakeProc[] = [];

vi.mock("child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("child_process")>();
  return {
    ...actual,
    spawn: vi.fn(() => {
      const proc = new EventEmitter() as unknown as FakeProc;
      proc.pid = 20000 + activeProcs.length;
      proc.exitCode = null;
      proc.stdout = new EventEmitter();
      proc.stderr = new EventEmitter();
      proc.kill = vi.fn();
      proc.unref = vi.fn();
      activeProcs.push(proc);
      return proc;
    }),
  };
});

/** Push a streamed stdout chunk through the Builder's reader. */
function emitStdout(proc: FakeProc, text: string): void {
  proc.stdout.emit("data", Buffer.from(text));
}

/** Settle a fake subprocess at the given exit code. */
function settleProc(proc: FakeProc, code: number): void {
  proc.exitCode = code;
  proc.emit("exit", code);
}

/** Let the detached post-install bundler microtask run to completion. */
async function flush(): Promise<void> {
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
}

const CMP_LINE =
  "Starting: Intent { cmp=com.acme.beta/com.acme.MainActivity }\n";

describe("Builder post-install auto-bundler", () => {
  beforeEach(() => {
    activeProcs.length = 0;
  });

  it("fires for android + deviceId + success with the captured package and port", async () => {
    const calls: Array<{ deviceId: string; appId: string; port: number }> = [];
    const applyBundler: AutoBundlerFn = async (opts) => {
      calls.push(opts);
      return { applied: true, detail: `debug_http_host=192.168.1.83:${opts.port}` };
    };
    const builder = new Builder({ applyBundler });

    const handle = builder.build({
      projectRoot: "/repo",
      platform: "android",
      deviceId: "R83W70PNCBZ",
      port: 8092,
      variant: "debug",
    });

    emitStdout(activeProcs[0]!, CMP_LINE);
    settleProc(activeProcs[0]!, 0);
    await handle.promise;
    await flush();

    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual({
      deviceId: "R83W70PNCBZ",
      appId: "com.acme.beta",
      port: 8092,
    });
  });

  it("does not fire for iOS builds", async () => {
    const applyBundler = vi.fn<AutoBundlerFn>(async () => ({ applied: true, detail: "" }));
    const builder = new Builder({ applyBundler });
    const handle = builder.build({
      projectRoot: "/repo",
      platform: "ios",
      deviceId: "UDID",
      port: 8081,
      variant: "debug",
    });
    settleProc(activeProcs[0]!, 0);
    await handle.promise;
    await flush();
    expect(applyBundler).not.toHaveBeenCalled();
  });

  it("does not fire without a deviceId (no physical device targeted)", async () => {
    const applyBundler = vi.fn<AutoBundlerFn>(async () => ({ applied: true, detail: "" }));
    const builder = new Builder({ applyBundler });
    const handle = builder.build({
      projectRoot: "/repo",
      platform: "android",
      port: 8092,
      variant: "debug",
    });
    emitStdout(activeProcs[0]!, CMP_LINE);
    settleProc(activeProcs[0]!, 0);
    await handle.promise;
    await flush();
    expect(applyBundler).not.toHaveBeenCalled();
  });

  it("does not fire when autoBundler is opted out", async () => {
    const applyBundler = vi.fn<AutoBundlerFn>(async () => ({ applied: true, detail: "" }));
    const builder = new Builder({ applyBundler });
    const handle = builder.build({
      projectRoot: "/repo",
      platform: "android",
      deviceId: "DEV1",
      port: 8092,
      variant: "debug",
      autoBundler: false,
    });
    emitStdout(activeProcs[0]!, CMP_LINE);
    settleProc(activeProcs[0]!, 0);
    await handle.promise;
    await flush();
    expect(applyBundler).not.toHaveBeenCalled();
  });

  it("does not fire when the build fails", async () => {
    const applyBundler = vi.fn<AutoBundlerFn>(async () => ({ applied: true, detail: "" }));
    const builder = new Builder({ applyBundler });
    const handle = builder.build({
      projectRoot: "/repo",
      platform: "android",
      deviceId: "DEV1",
      port: 8092,
      variant: "debug",
    });
    emitStdout(activeProcs[0]!, CMP_LINE);
    settleProc(activeProcs[0]!, 1);
    await handle.promise;
    await flush();
    expect(applyBundler).not.toHaveBeenCalled();
  });

  it("emits a visible 'skipped' line when no launch package was captured", async () => {
    const applyBundler = vi.fn<AutoBundlerFn>(async () => ({ applied: true, detail: "" }));
    const builder = new Builder({ applyBundler });
    const lines: string[] = [];
    builder.on("line", (e: { text: string }) => lines.push(e.text));

    const handle = builder.build({
      projectRoot: "/repo",
      platform: "android",
      deviceId: "DEV1",
      port: 8092,
      variant: "debug",
    });
    // No cmp= line streamed before exit.
    settleProc(activeProcs[0]!, 0);
    await handle.promise;
    await flush();

    expect(applyBundler).not.toHaveBeenCalled();
    expect(lines.some((l) => /Auto-bundler skipped/.test(l))).toBe(true);
  });

  it("never blocks done/resolver and survives a bundler that throws", async () => {
    const applyBundler: AutoBundlerFn = async () => {
      throw new Error("adb unreachable");
    };
    const builder = new Builder({ applyBundler });
    const lines: Array<{ text: string; stream: string }> = [];
    builder.on("line", (e: { text: string; stream: string }) => lines.push(e));

    const handle = builder.build({
      projectRoot: "/repo",
      platform: "android",
      deviceId: "DEV1",
      port: 8092,
      variant: "debug",
    });
    emitStdout(activeProcs[0]!, CMP_LINE);
    settleProc(activeProcs[0]!, 0);
    const result = await handle.promise;
    expect(result.success).toBe(true); // build still green
    await flush();
    expect(lines.some((l) => /Auto-bundler failed/.test(l.text) && l.stream === "stderr")).toBe(true);
  });
});
