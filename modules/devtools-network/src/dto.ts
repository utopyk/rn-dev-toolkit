/**
 * DTO layer for devtools-network MCP tools — ported from
 * `src/mcp/devtools-dto.ts` as part of Phase 9.
 *
 * Security control S5: without `captureBodies: true` in the module config,
 * request/response bodies are replaced with
 * `{ kind: "redacted", reason: "mcp-default" }`. The flag used to be an
 * MCP-server CLI (`--mcp-capture-bodies`); it's now a per-module config
 * value read from `ctx.config.captureBodies` on every tool call.
 */

import type {
  CapturedBody,
  CaptureListResult,
  CaptureMeta,
  Initiator,
  NetworkEntry,
} from "./types.js";

export interface NetworkEntryDto {
  requestId: string;
  sequence: number;
  terminalState: "pending" | "finished" | "failed";
  method: string;
  url: string;
  status?: number;
  statusText?: string;
  mimeType?: string;
  requestHeaders: Record<string, string>;
  responseHeaders?: Record<string, string>;
  requestBody: CapturedBody;
  responseBody?: CapturedBody;
  timings: { startedAt: number; completedAt?: number; durationMs?: number };
  initiator?: Initiator;
  redirectChain?: string[];
  failureReason?: string;
}

export interface DtoOptions {
  captureBodies: boolean;
}

export interface DevToolsListDto {
  entries: NetworkEntryDto[];
  cursorDropped: boolean;
  meta: CaptureMeta;
}

const REDACTED_BODY: CapturedBody = {
  kind: "redacted",
  reason: "mcp-default",
};

function projectBody(body: CapturedBody, opts: DtoOptions): CapturedBody {
  if (opts.captureBodies) return body;
  if (body.kind === "redacted" || body.kind === "absent") return body;
  return REDACTED_BODY;
}

/**
 * Central rewriter for the `CaptureMeta` envelope the module returns to
 * MCP callers. Keeps `bodyCapture` consistent across every tool surface
 * (status + list share one implementation so agents can't see
 * conflicting values). Returns the input unchanged when
 * `captureBodies: true`.
 */
export function projectMeta(meta: CaptureMeta, opts: DtoOptions): CaptureMeta {
  if (opts.captureBodies) return meta;
  return { ...meta, bodyCapture: "mcp-redacted" };
}

export function toDto(entry: NetworkEntry, opts: DtoOptions): NetworkEntryDto {
  const base: NetworkEntryDto = {
    requestId: entry.requestId,
    sequence: entry.sequence,
    terminalState: entry.terminalState,
    method: entry.method,
    url: entry.url,
    requestHeaders: { ...entry.requestHeaders },
    requestBody: projectBody(entry.requestBody, opts),
    timings: { startedAt: entry.timings.startedAt },
    initiator: entry.initiator,
    redirectChain: entry.redirectChain ? [...entry.redirectChain] : undefined,
  };
  if (entry.terminalState === "finished") {
    return {
      ...base,
      status: entry.status,
      statusText: entry.statusText,
      mimeType: entry.mimeType,
      responseHeaders: { ...entry.responseHeaders },
      responseBody: projectBody(entry.responseBody, opts),
      timings: {
        startedAt: entry.timings.startedAt,
        completedAt: entry.timings.completedAt,
        durationMs: entry.timings.durationMs,
      },
    };
  }
  if (entry.terminalState === "failed") {
    return {
      ...base,
      status: entry.status,
      responseHeaders: entry.responseHeaders
        ? { ...entry.responseHeaders }
        : undefined,
      failureReason: entry.failureReason,
      timings: {
        startedAt: entry.timings.startedAt,
        completedAt: entry.timings.completedAt,
        durationMs: entry.timings.durationMs,
      },
    };
  }
  return base;
}

export function toListDto(
  result: CaptureListResult<NetworkEntry>,
  opts: DtoOptions
): DevToolsListDto {
  return {
    entries: result.entries.map((e) => toDto(e, opts)),
    cursorDropped: result.cursorDropped,
    meta: projectMeta(result.meta, opts),
  };
}
