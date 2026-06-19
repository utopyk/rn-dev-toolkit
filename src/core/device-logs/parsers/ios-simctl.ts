/**
 * Parses `xcrun simctl spawn <udid> log stream --style ndjson` lines.
 *
 * Each line is a JSON object. Documented keys (Apple unified-log):
 *   - timestamp:        "2026-06-19 14:30:45.123Z"
 *   - processImagePath: "/Applications/.../Acme.app/Acme"
 *   - processID:        1234
 *   - subsystem:        "com.acme.beta"
 *   - category:         "Networking"
 *   - messageType:      "Default" | "Info" | "Debug" | "Error" | "Fault"
 *   - eventMessage:     "hello"
 *
 * We're defensive about missing fields — simulator log streams can
 * include non-message lines (header/footer) that don't have all keys.
 */

import type { DeviceLogLevel, DeviceLogLine } from "../types.js";

const TYPE_MAP: Readonly<Record<string, DeviceLogLevel>> = {
  Default: "info",
  Info: "info",
  Debug: "debug",
  Error: "error",
  Fault: "fault",
  // 'Activity' messages — surface as info; rare in app output.
  Activity: "info",
};

export interface IosSimctlParseInput {
  line: string;
  deviceId: string;
}

export interface IosSimctlParseResult {
  level: DeviceLogLevel;
  tag: string;
  pid: number;
  message: string;
}

interface NdjsonRecord {
  timestamp?: string;
  processImagePath?: string;
  processID?: number;
  subsystem?: string;
  category?: string;
  messageType?: string;
  eventMessage?: string;
}

function processName(imagePath: string | undefined): string {
  if (!imagePath) return "";
  const slash = imagePath.lastIndexOf("/");
  return slash >= 0 ? imagePath.slice(slash + 1) : imagePath;
}

export function parseSimctlNdjsonLine(
  raw: string,
): IosSimctlParseResult | null {
  const trimmed = raw.trim();
  if (!trimmed.startsWith("{")) return null;
  let rec: NdjsonRecord;
  try {
    rec = JSON.parse(trimmed) as NdjsonRecord;
  } catch {
    return null;
  }
  const message = typeof rec.eventMessage === "string" ? rec.eventMessage : "";
  if (!message) return null;
  // Build a tag like `subsystem:category` when both present, else the
  // process basename, else "". Mirrors the Console.app "Process | Subsystem"
  // pair so an agent searching by tag finds the same string a human would.
  let tag = "";
  if (rec.subsystem) tag = rec.subsystem;
  if (rec.category) tag = tag ? `${tag}:${rec.category}` : rec.category;
  if (!tag) tag = processName(rec.processImagePath);
  const level = TYPE_MAP[rec.messageType ?? ""] ?? "info";
  const pid = typeof rec.processID === "number" ? rec.processID : -1;
  return { level, tag, pid, message };
}

export function parseIosSimctlLine(
  input: IosSimctlParseInput,
): Omit<DeviceLogLine, "sequence" | "at"> | null {
  const parsed = parseSimctlNdjsonLine(input.line);
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
