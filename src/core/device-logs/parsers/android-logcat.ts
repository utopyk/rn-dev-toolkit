/**
 * Parses Android `logcat -v threadtime` lines.
 *
 * Format:
 *   `MM-DD HH:MM:SS.mmm  PID  TID L TAG: message`
 *
 * Examples:
 *   `06-19 14:30:45.123  1234  5678 I MyTag: doing the thing`
 *   `06-19 14:30:45.123  1234  5678 E ActivityManager: crashed`
 *
 * Continuation lines (multi-line messages emitted by Android's Log.x
 * with embedded newlines) start with whitespace — handled by the
 * caller, not this line-level parser. We return null on unparseable
 * input so the caller can attach the line as a continuation of the
 * previous entry.
 */

import type { DeviceLogLevel, DeviceLogLine } from "../types.js";

/** logcat priority letters → DeviceLogLevel. */
const LEVEL_MAP: Readonly<Record<string, DeviceLogLevel>> = {
  V: "debug", // verbose → debug (Android verbose is the lowest level)
  D: "debug",
  I: "info",
  W: "warn",
  E: "error",
  F: "fault", // F = fatal in logcat
  // S = silent → suppressed by the user; if it leaks through we map it
  // to debug so it's still visible but lowest priority.
  S: "debug",
};

// Match: MM-DD HH:MM:SS.mmm  PID  TID L  TAG: message
// Whitespace runs between fields are 1+ spaces (often 2 between PID/TID).
const THREADTIME_RE =
  /^(\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2}\.\d{3})\s+(\d+)\s+(\d+)\s+([VDIWEFS])\s+([^:]*?):\s?(.*)$/;

export interface AndroidParseInput {
  /** Raw line from `adb logcat -v threadtime`. */
  line: string;
  /** Device serial — copied verbatim into the resulting LogLine. */
  deviceId: string;
}

export interface AndroidParseResult {
  level: DeviceLogLevel;
  tag: string;
  pid: number;
  message: string;
}

/** Parse a single threadtime line. Returns null when the line doesn't
 *  match — caller should treat as a continuation of the previous entry
 *  or drop it (header lines from `--------- beginning of …` etc.). */
export function parseLogcatThreadtimeLine(
  raw: string,
): AndroidParseResult | null {
  const m = THREADTIME_RE.exec(raw);
  if (!m) return null;
  const [, , pidStr, , levelChar, tagRaw, messageRaw] = m;
  const level = LEVEL_MAP[levelChar!] ?? "info";
  const pid = Number(pidStr);
  return {
    level,
    tag: tagRaw!.trim(),
    pid: Number.isFinite(pid) ? pid : -1,
    message: messageRaw ?? "",
  };
}

/** Convenience wrapper that returns a full `Omit<DeviceLogLine, "sequence"|"at">`
 *  ready to hand to `DeviceLogsStore.append()`. */
export function parseAndroidLine(
  input: AndroidParseInput,
): Omit<DeviceLogLine, "sequence" | "at"> | null {
  const parsed = parseLogcatThreadtimeLine(input.line);
  if (!parsed) return null;
  return {
    source: "android",
    deviceId: input.deviceId,
    level: parsed.level,
    tag: parsed.tag,
    pid: parsed.pid,
    message: parsed.message,
  };
}
