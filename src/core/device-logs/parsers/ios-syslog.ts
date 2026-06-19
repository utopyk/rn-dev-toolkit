/**
 * Parses `idevicesyslog` lines (physical iOS, classic syslog format).
 *
 * Format:
 *   `MMM DD HH:MM:SS DeviceName process[pid] <Priority>: message`
 *
 * Examples:
 *   `Jun 19 14:30:45 iPhone Acme[1234] <Notice>: hello`
 *   `Jun 19 14:30:45 iPhone Acme(libsystem_blocks.dylib)[1234] <Warning>: ...`
 *
 * Continuation lines (long messages broken across multiple lines) start
 * with whitespace — caller treats those as continuations.
 */

import type { DeviceLogLevel, DeviceLogLine } from "../types.js";

/** Apple unified-log priority strings → DeviceLogLevel. */
const PRIORITY_MAP: Readonly<Record<string, DeviceLogLevel>> = {
  debug: "debug",
  info: "info",
  notice: "info",   // syslog 'notice' is "general info worth recording"
  warning: "warn",
  error: "error",
  fault: "fault",
};

// `MMM DD HH:MM:SS host process[pid] <Level>: message`
// process may include parenthesized image name: `Acme(libsystem_blocks.dylib)`
const SYSLOG_RE =
  /^[A-Z][a-z]{2}\s+\d{1,2}\s+\d{2}:\d{2}:\d{2}\s+\S+\s+([^[]+)\[(\d+)\]\s+<([A-Za-z]+)>:\s?(.*)$/;

export interface IosSyslogParseInput {
  line: string;
  deviceId: string;
}

export interface IosSyslogParseResult {
  level: DeviceLogLevel;
  tag: string; // process name
  pid: number;
  message: string;
}

export function parseIdevicesyslogLine(raw: string): IosSyslogParseResult | null {
  const m = SYSLOG_RE.exec(raw);
  if (!m) return null;
  const [, procRaw, pidStr, priorityRaw, message] = m;
  const tag = (procRaw ?? "").trim();
  const pid = Number(pidStr);
  const level = PRIORITY_MAP[priorityRaw!.toLowerCase()] ?? "info";
  return {
    level,
    tag,
    pid: Number.isFinite(pid) ? pid : -1,
    message: message ?? "",
  };
}

export function parseIosSyslogLine(
  input: IosSyslogParseInput,
): Omit<DeviceLogLine, "sequence" | "at"> | null {
  const parsed = parseIdevicesyslogLine(input.line);
  if (!parsed) return null;
  return {
    source: "ios",
    deviceId: input.deviceId,
    level: parsed.level,
    tag: parsed.tag,
    pid: parsed.pid,
    message: parsed.message,
  };
}
