import { describe, expect, it, vi } from "vitest";
import { createAndroidAdapter, parseDevices } from "../android-adapter.js";

describe("parseDevices (android)", () => {
  it("parses the happy-path `adb devices -l` output", () => {
    const raw = [
      "List of devices attached",
      "emulator-5554         device product:sdk_gphone_x86 model:Pixel_6 device:emulator transport_id:1",
      "0A0B0C0D0E            device product:raven model:Pixel_6_Pro device:raven transport_id:2",
      "",
    ].join("\n");
    const devices = parseDevices(raw);
    expect(devices).toHaveLength(2);
    expect(devices[0]).toMatchObject({
      udid: "emulator-5554",
      name: "Pixel_6",
      platform: "android",
      state: "booted",
    });
    expect(devices[1]).toMatchObject({
      udid: "0A0B0C0D0E",
      name: "Pixel_6_Pro",
      state: "booted",
    });
  });

  it("maps offline/unauthorized to 'unavailable'", () => {
    const raw = [
      "List of devices attached",
      "emulator-5554 offline",
      "aabbccddee   unauthorized",
    ].join("\n");
    const devices = parseDevices(raw);
    expect(devices).toHaveLength(2);
    expect(devices[0]?.state).toBe("unavailable");
    expect(devices[1]?.state).toBe("unavailable");
  });

  it("skips empty lines and the header", () => {
    const raw = "List of devices attached\n\n\n";
    expect(parseDevices(raw)).toEqual([]);
  });
});

describe("AndroidAdapter (via runAdb stub)", () => {
  it("list() returns 'unavailable' when runAdb throws ENOENT", async () => {
    const adapter = createAndroidAdapter({
      runAdb: async () => {
        throw new Error('adb: spawn adb ENOENT');
      },
    });
    const result = await adapter.list();
    expect(result.kind).toBe("unavailable");
    if (result.kind === "unavailable") {
      expect(result.reason).toContain("adb");
    }
  });

  it("tap() shells `input tap` with rounded coords", async () => {
    const runAdb = vi.fn(async () => "");
    const adapter = createAndroidAdapter({ runAdb });
    await adapter.tap("emulator-5554", 123.7, 456.2);
    expect(runAdb).toHaveBeenCalledWith(
      "adb",
      [
        "-s",
        "emulator-5554",
        "shell",
        "input",
        "tap",
        "124",
        "456",
      ],
      undefined,
    );
  });

  it("typeText() single-quotes the payload and escapes spaces as %s inside the quotes", async () => {
    const runAdb = vi.fn(async () => "");
    const adapter = createAndroidAdapter({ runAdb });
    await adapter.typeText("emulator-5554", "hello world and more");
    expect(runAdb).toHaveBeenCalledWith(
      "adb",
      [
        "-s",
        "emulator-5554",
        "shell",
        "input",
        "text",
        "'hello%sworld%sand%smore'",
      ],
      undefined,
    );
  });

  it("typeText() neutralizes shell metacharacters (defense against device-side re-parse)", async () => {
    const runAdb = vi.fn(async () => "");
    const adapter = createAndroidAdapter({ runAdb });
    // The bytes `"$(id)"`, backticks, and `;cmd` must survive unchanged
    // inside the single-quoted shell argument. `'\''` splices an escaped
    // single quote without closing the wrapper.
    await adapter.typeText("udid", "$(id)`reboot`;pm list\\'n");
    const argv = runAdb.mock.calls[0]?.[1] as string[];
    const payload = argv[argv.length - 1];
    // Must be single-quoted at both ends.
    expect(payload?.startsWith("'")).toBe(true);
    expect(payload?.endsWith("'")).toBe(true);
    // Embedded single quote is escaped as '\''.
    expect(payload).toContain("'\\''");
    // Dangerous sequences still appear inside the quotes (spaces become
    // %s per adb's `input text` convention, but the metacharacters that
    // mattered for shell re-parsing — $(), backticks, ; — survive
    // verbatim where they're now inert because of the quoting.
    expect(payload).toContain("$(id)");
    expect(payload).toContain("`reboot`");
    expect(payload).toContain(";pm%slist");
  });

  it("swipe() passes correct argv with durationMs", async () => {
    const runAdb = vi.fn(async () => "");
    const adapter = createAndroidAdapter({ runAdb });
    await adapter.swipe("udid", 10, 20, 30, 40, 250);
    expect(runAdb).toHaveBeenCalledWith(
      "adb",
      [
        "-s",
        "udid",
        "shell",
        "input",
        "swipe",
        "10",
        "20",
        "30",
        "40",
        "250",
      ],
      undefined,
    );
  });

  it("launchApp() uses monkey with the package id", async () => {
    const runAdb = vi.fn(async () => "");
    const adapter = createAndroidAdapter({ runAdb });
    await adapter.launchApp("udid", "com.example.app");
    const call = runAdb.mock.calls[0];
    expect(call?.[1]).toEqual([
      "-s",
      "udid",
      "shell",
      "monkey",
      "-p",
      "com.example.app",
      "-c",
      "android.intent.category.LAUNCHER",
      "1",
    ]);
  });

  it("logsTail splits lines and respects the lines param", async () => {
    const runAdb = vi.fn(async () => "line one\nline two\nline three\n");
    const adapter = createAndroidAdapter({ runAdb });
    const { lines } = await adapter.logsTail("udid", 10);
    expect(lines).toEqual(["line one", "line two", "line three"]);
    expect(runAdb.mock.calls[0]?.[1]).toEqual([
      "-s",
      "udid",
      "logcat",
      "-d",
      "-t",
      "10",
    ]);
  });
});
