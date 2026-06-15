import { describe, it, expect } from "vitest";
import {
  applyAndroidBundler,
  extractAndroidPackage,
  upsertDebugHttpHost,
  type AdbRunner,
} from "../android-bundler.js";

describe("extractAndroidPackage", () => {
  it("pulls the package from an `am start` Starting: Intent line", () => {
    const out =
      "info Starting the app on R83W70PNCBZ...\nStarting: Intent { cmp=com.acme.beta/com.acme.MainActivity }\n";
    expect(extractAndroidPackage(out)).toBe("com.acme.beta");
  });

  it("handles a dotted activity and the base (no-suffix) package", () => {
    expect(
      extractAndroidPackage("Starting: Intent { cmp=com.acme/.MainActivity }"),
    ).toBe("com.acme");
  });

  it("returns null when there is no launch line", () => {
    expect(extractAndroidPackage("BUILD SUCCESSFUL in 42s")).toBeNull();
  });
});

describe("upsertDebugHttpHost", () => {
  it("synthesizes a fresh map when none exists", () => {
    const out = upsertDebugHttpHost("", "192.168.1.83:8092");
    expect(out).toContain("<map>");
    expect(out).toContain('<string name="debug_http_host">192.168.1.83:8092</string>');
  });

  it("inserts without clobbering existing prefs", () => {
    const existing = `<map>\n    <boolean name="x" value="true" />\n</map>`;
    const out = upsertDebugHttpHost(existing, "10.0.0.5:8081");
    expect(out).toContain('<boolean name="x" value="true" />');
    expect(out).toContain('<string name="debug_http_host">10.0.0.5:8081</string>');
  });

  it("replaces an existing value (no duplicate)", () => {
    const existing = `<map>\n    <string name="debug_http_host">old:1</string>\n</map>`;
    const out = upsertDebugHttpHost(existing, "new:2");
    expect(out).not.toContain("old:1");
    expect(out.match(/name="debug_http_host"/g)?.length).toBe(1);
  });
});

describe("applyAndroidBundler", () => {
  it("reads prefs, writes the merged host via run-as, force-stops", async () => {
    const calls: { argv: readonly string[]; input?: string }[] = [];
    const runAdb: AdbRunner = async (argv, input) => {
      calls.push({ argv, input });
      if (argv.includes("cat")) return `<map>\n    <boolean name="x" value="true" />\n</map>`;
      return "";
    };

    const res = await applyAndroidBundler(
      { deviceId: "R83W70PNCBZ", appId: "com.acme.beta", port: 8092 },
      { runAdb, resolveHost: () => "192.168.1.83" },
    );

    expect(res.applied).toBe(true);
    expect(res.detail).toContain("192.168.1.83:8092");

    const read = calls.find((c) => c.argv.includes("cat"));
    expect(read?.argv).toEqual(
      expect.arrayContaining(["-s", "R83W70PNCBZ", "exec-out", "run-as", "com.acme.beta"]),
    );

    const write = calls.find((c) => c.input !== undefined);
    expect(write?.argv.join(" ")).toContain("run-as com.acme.beta sh -c");
    expect(write?.input).toContain('<string name="debug_http_host">192.168.1.83:8092</string>');
    expect(write?.input).toContain('<boolean name="x" value="true" />');

    expect(calls.some((c) => c.argv.includes("am") && c.argv.includes("force-stop"))).toBe(true);
  });

  it("skips (applied:false) when there is no LAN IP, never touching adb", async () => {
    let touched = false;
    const runAdb: AdbRunner = async () => {
      touched = true;
      return "";
    };
    const res = await applyAndroidBundler(
      { deviceId: "EMU1", appId: "com.acme", port: 8081 },
      { runAdb, resolveHost: () => null },
    );
    expect(res.applied).toBe(false);
    expect(res.detail).toMatch(/adb reverse/);
    expect(touched).toBe(false);
  });

  it("rejects an unsafe appId before resolving a host or shelling out", async () => {
    let touched = false;
    await expect(
      applyAndroidBundler(
        { deviceId: "EMU1", appId: "com.acme; rm -rf /", port: 1 },
        {
          runAdb: async () => {
            touched = true;
            return "";
          },
          resolveHost: () => "10.0.0.1",
        },
      ),
    ).rejects.toThrow(/unsafe appId/);
    expect(touched).toBe(false);
  });

  it("starts a fresh prefs map when the cat read fails (file absent)", async () => {
    const writes: (string | undefined)[] = [];
    const runAdb: AdbRunner = async (argv, input) => {
      if (argv.includes("cat")) throw new Error("run-as: ...: No such file");
      if (input !== undefined) writes.push(input);
      return "";
    };
    const res = await applyAndroidBundler(
      { deviceId: "EMU1", appId: "com.acme", port: 8081 },
      { runAdb, resolveHost: () => "10.0.0.5" },
    );
    expect(res.applied).toBe(true);
    expect(writes[0]).toContain("<map>");
    expect(writes[0]).toContain('<string name="debug_http_host">10.0.0.5:8081</string>');
  });
});
