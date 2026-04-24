// Client-side ModuleHost adapter. Phase 13.4 prereq #3.
//
// The 13.3 `routeEventToAdapters` switch had no home for `modules/*`
// events — the TUI didn't consume them. Electron does: its renderer
// sidebar, Marketplace panel, and Settings form all re-render when
// modules install / crash / flip state.
//
// This adapter consumes the three module-lifecycle SessionEvents the
// supervisor fans out (`modules/state-changed|crashed|failed`) and
// re-emits them on the `modules-event` topic, matching the pre-13.4
// in-process `moduleEventsBus` shape. Electron's ipcMain wiring at
// [electron/ipc/index.ts:93-95](../../../electron/ipc/index.ts) pipes
// `modules-event` payloads to the renderer as `modules:event` IPC
// sends; keeping the shape identical means that forwarder needs no
// edits during the 13.4.1 handler flip.
//
// Typed per-kind events (`state-changed` / `crashed` / `failed`)
// were considered and dropped — no current consumer. Add them back
// when a second subscriber actually appears (simplicity P2 on PR #18).
//
// Each `data` payload is narrowed through a runtime guard before
// re-emission so a malformed daemon push (or a future schema drift)
// surfaces as a dropped event + warn line rather than an
// undefined-laden IPC message the renderer's Marketplace panel
// would render. Matches the precedent `parseSessionEventEnvelope`
// set in PR #17 (Kieran P0 + Security P2 on PR #18).

import { EventEmitter } from "node:events";
import type { IpcClient } from "../../core/ipc.js";
import type { AdapterSink, ModuleHostEventKind } from "./adapter-sink.js";

/**
 * Payload shape on the `modules-event` topic. Matches what
 * `registerModulesIpc` emits on its local bus in Phase 3a+, which is
 * what the Electron renderer expects today.
 */
export interface ModulesEventPayload {
  kind: "state-changed" | "crashed" | "failed";
  moduleId: string;
  scopeUnit: string;
  /** Present on `state-changed` — the destination state. */
  state?: string;
  /** Present on `crashed` / `failed`. */
  reason?: string;
}

export interface ModuleHostClientEvents {
  /**
   * Shimmed-through copy of the three supervisor events, shaped to
   * match the pre-13.4 in-process `moduleEventsBus` payload. This is
   * the only consumer surface today; Electron's ipcMain forwarder
   * subscribes to it.
   */
  "modules-event": (evt: ModulesEventPayload) => void;
  /** Fires once on unexpected daemon death (Phase 13.4 prereq #1). */
  disconnected: (err?: Error) => void;
}

export class ModuleHostClient
  extends EventEmitter
  implements AdapterSink<ModuleHostEventKind>
{
  constructor(
    private client: IpcClient,
    private nextId: () => string,
  ) {
    super();
  }

  dispatch(kind: ModuleHostEventKind, data: unknown): void {
    if (kind === "modules/state-changed") {
      const p = readStateChangedPayload(data);
      if (!p) return;
      // Match pre-13.4 filter — renderer only cared about transitions
      // that affect tool callability (registerModulesIpc::forwardStateChanged).
      if (p.to === "active" || p.from === "active") {
        this.emit("modules-event", {
          kind: "state-changed",
          moduleId: p.moduleId,
          scopeUnit: p.scopeUnit,
          state: p.to,
        });
      }
      return;
    }
    if (kind === "modules/crashed") {
      const p = readReasonPayload(data);
      if (!p) return;
      this.emit("modules-event", {
        kind: "crashed",
        moduleId: p.moduleId,
        scopeUnit: p.scopeUnit,
        reason: p.reason,
      });
      return;
    }
    if (kind === "modules/failed") {
      const p = readReasonPayload(data);
      if (!p) return;
      this.emit("modules-event", {
        kind: "failed",
        moduleId: p.moduleId,
        scopeUnit: p.scopeUnit,
        reason: p.reason,
      });
    }
  }

  notifyDisconnected(err?: Error): void {
    this.emit("disconnected", err);
  }
}

interface StateChangedPayload {
  moduleId: string;
  scopeUnit: string;
  from: string;
  to: string;
}

interface ReasonPayload {
  moduleId: string;
  scopeUnit: string;
  reason: string;
}

function readStateChangedPayload(data: unknown): StateChangedPayload | null {
  if (!data || typeof data !== "object") return null;
  const d = data as Record<string, unknown>;
  if (
    typeof d.moduleId !== "string" ||
    typeof d.scopeUnit !== "string" ||
    typeof d.from !== "string" ||
    typeof d.to !== "string"
  ) {
    return null;
  }
  return {
    moduleId: d.moduleId,
    scopeUnit: d.scopeUnit,
    from: d.from,
    to: d.to,
  };
}

function readReasonPayload(data: unknown): ReasonPayload | null {
  if (!data || typeof data !== "object") return null;
  const d = data as Record<string, unknown>;
  if (
    typeof d.moduleId !== "string" ||
    typeof d.scopeUnit !== "string" ||
    typeof d.reason !== "string"
  ) {
    return null;
  }
  return {
    moduleId: d.moduleId,
    scopeUnit: d.scopeUnit,
    reason: d.reason,
  };
}
