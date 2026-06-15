import { describe, expect, it } from "vitest";
import {
  createAndroidAdapter,
  upsertDebugHttpHost,
} from "../android-adapter.js";
import { createIosAdapter } from "../ios-adapter.js";

describe("upsertDebugHttpHost", () => {
  it("creates a fresh prefs map when none exists", () => {
    const out = upsertDebugHttpHost("", "192.168.1.83:8092");
    expect(out).toContain("<map>");
    expect(out).toContain(
      '<string name="debug_http_host">192.168.1.83:8092</string>',
    );
  });

  it("inserts the key into an existing map without clobbering other prefs", () => {
    const existing = `<?xml version='1.0' encoding='utf-8' standalone='yes' ?>\n<map>\n    <boolean name="flipper_enabled" value="true" />\n</map>`;
    const out = upsertDebugHttpHost(existing, "10.0.0.5:8081");
    expect(out).toContain('<boolean name="flipper_enabled" value="true" />');
    expect(out).toContain('<string name="debug_http_host">10.0.0.5:8081</string>');
  });

  it("replaces an existing debug_http_host value (no duplicate)", () => {
    const existing = `<map>\n    <string name="debug_http_host">old.host:8081</string>\n</map>`;
    const out = upsertDebugHttpHost(existing, "new.host:8092");
    expect(out).toContain('<string name="debug_http_host">new.host:8092</string>');
    expect(out).not.toContain("old.host:8081");
    expect(out.match(/name="debug_http_host"/g)?.length).toBe(1);
  });
});

interface AdbCall {
  argv: readonly string[];
  input?: string;
}

describe("AndroidAdapter.setBundler", () => {
  it("reads prefs, writes the merged host via run-as stdin, force-stops", async () => {
    const calls: AdbCall[] = [];
    const adapter = createAndroidAdapter({
      runAdb: async (_bin, argv, options) => {
        calls.push({ argv, input: options?.input });
        if (argv.includes("cat")) {
          return `<map>\n    <boolean name="x" value="true" />\n</map>`;
        }
        return "";
      },
    });

    const res = await adapter.setBundler("EMU1", {
      appId: "com.acme.beta",
      host: "192.168.1.83",
      port: 8092,
    });

    expect(res.applied).toBe(true);
    expect(res.detail).toContain("192.168.1.83:8092");

    const read = calls.find((c) => c.argv.includes("cat"));
    expect(read?.argv).toEqual(
      expect.arrayContaining(["-s", "EMU1", "exec-out", "run-as", "com.acme.beta"]),
    );

    const write = calls.find((c) => c.input !== undefined);
    expect(write).toBeDefined();
    expect(write?.argv.join(" ")).toContain("run-as com.acme.beta sh -c");
    // merged: our key added, the app's other pref preserved
    expect(write?.input).toContain(
      '<string name="debug_http_host">192.168.1.83:8092</string>',
    );
    expect(write?.input).toContain('<boolean name="x" value="true" />');

    expect(
      calls.some((c) => c.argv.includes("am") && c.argv.includes("force-stop")),
    ).toBe(true);
  });

  it("starts a fresh prefs map when the file does not exist (cat errors)", async () => {
    const writes: (string | undefined)[] = [];
    const adapter = createAndroidAdapter({
      runAdb: async (_bin, argv, options) => {
        if (argv.includes("cat")) throw new Error("run-as: ...: No such file or directory");
        if (options?.input !== undefined) writes.push(options.input);
        return "";
      },
    });

    const res = await adapter.setBundler("EMU1", {
      appId: "com.acme",
      host: "10.0.0.5",
      port: 8081,
    });
    expect(res.applied).toBe(true);
    expect(writes[0]).toContain("<map>");
    expect(writes[0]).toContain('<string name="debug_http_host">10.0.0.5:8081</string>');
  });

  it("rejects an unsafe appId before shelling out", async () => {
    let called = false;
    const adapter = createAndroidAdapter({
      runAdb: async () => {
        called = true;
        return "";
      },
    });
    await expect(
      adapter.setBundler("EMU1", {
        appId: "com.acme; rm -rf /",
        host: "h",
        port: 1,
      }),
    ).rejects.toThrow(/unsafe appId/);
    expect(called).toBe(false);
  });
});

describe("IosAdapter.setBundler", () => {
  it("is a no-op (physical devices use the baked ip.txt)", async () => {
    const adapter = createIosAdapter();
    const res = await adapter.setBundler("UDID", {
      appId: "com.acme",
      host: "h",
      port: 1,
    });
    expect(res.applied).toBe(false);
    expect(res.detail).toContain("ip.txt");
  });
});
