/**
 * Parser unit tests — pure functions, no spawning. Each parser is tested
 * against canonical line shapes from the man pages + Apple/Android docs.
 */

import { describe, it, expect } from "vitest";
import { parseLogcatThreadtimeLine, parseAndroidLine } from "../parsers/android-logcat.js";
import { parseIdevicesyslogLine, parseIosSyslogLine } from "../parsers/ios-syslog.js";
import { parseSimctlNdjsonLine, parseIosSimctlLine } from "../parsers/ios-simctl.js";

describe("Android logcat threadtime parser", () => {
  it("parses a vanilla info line", () => {
    const r = parseLogcatThreadtimeLine("06-19 14:30:45.123  1234  5678 I MyTag: doing the thing");
    expect(r).toEqual({ level: "info", tag: "MyTag", pid: 1234, message: "doing the thing" });
  });

  it("maps V → debug, D → debug, I → info, W → warn, E → error, F → fault", () => {
    const cases: Array<[string, string]> = [
      ["V", "debug"],
      ["D", "debug"],
      ["I", "info"],
      ["W", "warn"],
      ["E", "error"],
      ["F", "fault"],
    ];
    for (const [letter, expected] of cases) {
      const r = parseLogcatThreadtimeLine(`06-19 14:30:45.123  1234  5678 ${letter} Tag: msg`);
      expect(r?.level).toBe(expected);
    }
  });

  it("handles tags with internal spaces and dashes", () => {
    const r = parseLogcatThreadtimeLine("06-19 14:30:45.123  1234  5678 I com.acme.beta: ready");
    expect(r?.tag).toBe("com.acme.beta");
    expect(r?.message).toBe("ready");
  });

  it("returns null for header lines (--------- beginning of main)", () => {
    expect(parseLogcatThreadtimeLine("--------- beginning of main")).toBeNull();
  });

  it("returns null for empty + whitespace-only lines", () => {
    expect(parseLogcatThreadtimeLine("")).toBeNull();
    expect(parseLogcatThreadtimeLine("   ")).toBeNull();
  });

  it("returns null for free-form continuation lines", () => {
    expect(parseLogcatThreadtimeLine("    at SomeClass.method(File.java:42)")).toBeNull();
  });

  it("wrapper attaches source + deviceId", () => {
    const r = parseAndroidLine({
      line: "06-19 14:30:45.123  1234  5678 W MyTag: heads up",
      deviceId: "R5CX23WBLKE",
    });
    expect(r).toEqual({
      source: "android",
      deviceId: "R5CX23WBLKE",
      level: "warn",
      tag: "MyTag",
      pid: 1234,
      message: "heads up",
    });
  });
});

describe("iOS idevicesyslog parser", () => {
  it("parses a notice line", () => {
    const r = parseIdevicesyslogLine("Jun 19 14:30:45 iPhone Acme[1234] <Notice>: hello");
    expect(r).toEqual({ level: "info", tag: "Acme", pid: 1234, message: "hello" });
  });

  it("maps priorities", () => {
    const cases: Array<[string, string]> = [
      ["Debug", "debug"],
      ["Info", "info"],
      ["Notice", "info"],
      ["Warning", "warn"],
      ["Error", "error"],
      ["Fault", "fault"],
    ];
    for (const [pri, expected] of cases) {
      const r = parseIdevicesyslogLine(`Jun 19 14:30:45 iPhone proc[1] <${pri}>: m`);
      expect(r?.level).toBe(expected);
    }
  });

  it("handles parenthesized image names in the process field", () => {
    const r = parseIdevicesyslogLine(
      "Jun 19 14:30:45 iPhone Acme(libsystem_blocks.dylib)[1234] <Warning>: broken",
    );
    expect(r?.tag).toBe("Acme(libsystem_blocks.dylib)");
    expect(r?.message).toBe("broken");
  });

  it("returns null for unstructured lines", () => {
    expect(parseIdevicesyslogLine("[connecting (network mode)...]")).toBeNull();
    expect(parseIdevicesyslogLine("")).toBeNull();
  });

  it("wrapper attaches source + deviceId", () => {
    const r = parseIosSyslogLine({
      line: "Jun 19 14:30:45 iPhone Acme[1234] <Error>: blew up",
      deviceId: "00008110-0001234567890ABC",
    });
    expect(r).toMatchObject({
      source: "ios",
      deviceId: "00008110-0001234567890ABC",
      level: "error",
      message: "blew up",
    });
  });
});

describe("iOS simctl ndjson parser", () => {
  it("parses a vanilla record", () => {
    const line = JSON.stringify({
      timestamp: "2026-06-19 14:30:45.123Z",
      processImagePath: "/Applications/.../Acme.app/Acme",
      processID: 1234,
      subsystem: "com.acme.beta",
      category: "Networking",
      messageType: "Default",
      eventMessage: "request finished",
    });
    const r = parseSimctlNdjsonLine(line);
    expect(r).toEqual({
      level: "info",
      tag: "com.acme.beta:Networking",
      pid: 1234,
      message: "request finished",
    });
  });

  it("maps messageType → level", () => {
    const cases: Array<[string, string]> = [
      ["Default", "info"],
      ["Info", "info"],
      ["Debug", "debug"],
      ["Error", "error"],
      ["Fault", "fault"],
    ];
    for (const [t, expected] of cases) {
      const r = parseSimctlNdjsonLine(
        JSON.stringify({ messageType: t, eventMessage: "m" }),
      );
      expect(r?.level).toBe(expected);
    }
  });

  it("falls back to processImagePath basename when subsystem/category absent", () => {
    const r = parseSimctlNdjsonLine(
      JSON.stringify({ processImagePath: "/Apps/Acme.app/Acme", eventMessage: "x" }),
    );
    expect(r?.tag).toBe("Acme");
  });

  it("returns null for non-JSON + JSON without eventMessage", () => {
    expect(parseSimctlNdjsonLine("not json")).toBeNull();
    expect(parseSimctlNdjsonLine("{}")).toBeNull();
    expect(parseSimctlNdjsonLine(JSON.stringify({ subsystem: "x" }))).toBeNull();
  });

  it("wrapper attaches source + deviceId", () => {
    const r = parseIosSimctlLine({
      line: JSON.stringify({ messageType: "Info", eventMessage: "m", processID: 5 }),
      deviceId: "F2E3-...",
    });
    expect(r).toMatchObject({ source: "ios", deviceId: "F2E3-...", level: "info" });
  });
});
