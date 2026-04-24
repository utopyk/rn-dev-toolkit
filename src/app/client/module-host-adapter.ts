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
import type {
  HostCallReply,
  HostCallRequest,
  ListPanelsReply,
  ResolvePanelError,
  ResolvePanelReply,
  ModuleCallRequest,
  ModuleCallSuccess,
  ModuleCallError,
  ModuleConfigGetResult,
  ModuleConfigSetRequest,
  ModuleConfigSetResult,
  ModuleInstallRequest,
  ModuleInstallReply,
  ModuleUninstallReply,
  MarketplaceInfoReply,
  MarketplaceListReply,
  RegisteredModuleRow,
} from "../modules-ipc.js";

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
  private eventSub: { close: () => void } | null = null;

  constructor(
    private client: IpcClient,
    private nextId: () => string,
  ) {
    super();
  }

  /**
   * Open a `modules/subscribe` stream against the daemon so this adapter
   * re-emits the full breadth of module-lifecycle events on the local
   * `modules-event` topic. Phase 13.4.1 — `dispatch()` only covers the
   * three supervisor-level events (`state-changed` / `crashed` /
   * `failed`) that ride the session-level `events/subscribe` stream.
   * `install` / `uninstall` / `enabled` / `disabled` / `restarted` /
   * `config-changed` live on a separate daemon-local bus consumed only
   * by `modules/subscribe` clients — without this method, Electron's
   * Marketplace + Settings panels never see those events post-flip.
   *
   * Idempotent: returns the existing subscription if already open.
   * Callers (Electron's handler wiring) invoke it once when the
   * daemon-client adapter is published on the serviceBus; the
   * subscription tears down with the underlying socket when the
   * daemon disconnects.
   */
  async subscribeToEvents(): Promise<{ close: () => void }> {
    if (this.eventSub) return this.eventSub;
    const sub = await this.client.subscribe(
      {
        type: "command",
        action: "modules/subscribe",
        id: this.nextId(),
      },
      {
        onEvent: (msg) => {
          // Wire format: { type: "event", action: "modules/event",
          //               payload: ModulesEvent, id: ... }
          const payload = msg.payload;
          if (!payload || typeof payload !== "object") return;
          const evt = payload as Record<string, unknown>;
          if (typeof evt.kind !== "string" || typeof evt.moduleId !== "string") {
            return;
          }
          this.emit("modules-event", payload);
        },
        onError: () => {
          // Socket-level errors fan out through `notifyDisconnected`
          // instead; `onError` from `events/subscribe`-style streams is
          // the same hazard the session orchestrator already handles.
        },
        onClose: () => {
          this.eventSub = null;
        },
      },
    );
    this.eventSub = sub;
    return sub;
  }

  // ---------------------------------------------------------------------------
  // RPC methods — Phase 13.4.1. Every `modules/*` + `marketplace/*` action
  // the Electron handlers consume, wired as a thin `client.send` wrapper so
  // callers don't re-derive action names + payload typing at each site.
  // The replies are passed through verbatim; wire-level `{ error: string }`
  // error shapes returned by the daemon's registrar are mapped to the
  // dispatcher's typed error shape at the caller — the adapter is not the
  // right place to invent a unified error envelope across 10 RPCs.
  // ---------------------------------------------------------------------------

  async list(): Promise<{ modules: RegisteredModuleRow[] }> {
    const resp = await this.client.send({
      type: "command",
      action: "modules/list",
      id: this.nextId(),
    });
    return resp.payload as { modules: RegisteredModuleRow[] };
  }

  async listPanels(): Promise<ListPanelsReply> {
    const resp = await this.client.send({
      type: "command",
      action: "modules/list-panels",
      id: this.nextId(),
    });
    return resp.payload as ListPanelsReply;
  }

  async resolvePanel(
    moduleId: string,
    panelId: string,
  ): Promise<ResolvePanelReply | ResolvePanelError> {
    const resp = await this.client.send({
      type: "command",
      action: "modules/resolve-panel",
      id: this.nextId(),
      payload: { moduleId, panelId },
    });
    // Runtime narrowing — `resolvePanel` consumers feed the returned
    // `moduleRoot` into the Electron panel-bridge, which uses it to
    // resolve `webviewEntry` paths for WebContentsView construction.
    // A malformed daemon reply would land as an undefined moduleRoot
    // the bridge can't validate against its "path inside module root"
    // check, so narrow before returning. Kieran P1-4 on PR #20.
    return readResolvePanelReply(resp.payload);
  }

  async call(
    payload: ModuleCallRequest,
  ): Promise<ModuleCallSuccess | ModuleCallError> {
    const resp = await this.client.send({
      type: "command",
      action: "modules/call",
      id: this.nextId(),
      payload,
    });
    return resp.payload as ModuleCallSuccess | ModuleCallError;
  }

  async hostCall(payload: HostCallRequest): Promise<HostCallReply> {
    const resp = await this.client.send({
      type: "command",
      action: "modules/host-call",
      id: this.nextId(),
      payload,
    });
    // Runtime narrowing — host-call's reply drives audit outcomes + the
    // consumer panel's error path. Drop malformed payloads into a
    // synthetic HOST_CALL_FAILED rather than propagating `undefined`
    // into a downstream `.kind` discriminator that'll crash the
    // renderer. Kieran P1-4 on PR #20.
    return readHostCallReply(resp.payload);
  }

  async configGet(
    moduleId: string,
    scopeUnit?: string,
  ): Promise<ModuleConfigGetResult | { error: string }> {
    const resp = await this.client.send({
      type: "command",
      action: "modules/config/get",
      id: this.nextId(),
      payload: scopeUnit === undefined ? { moduleId } : { moduleId, scopeUnit },
    });
    return resp.payload as ModuleConfigGetResult | { error: string };
  }

  async configSet(
    payload: ModuleConfigSetRequest,
  ): Promise<ModuleConfigSetResult> {
    const resp = await this.client.send({
      type: "command",
      action: "modules/config/set",
      id: this.nextId(),
      payload,
    });
    return resp.payload as ModuleConfigSetResult;
  }

  async install(payload: ModuleInstallRequest): Promise<ModuleInstallReply> {
    const resp = await this.client.send({
      type: "command",
      action: "modules/install",
      id: this.nextId(),
      payload,
    });
    return resp.payload as ModuleInstallReply;
  }

  async uninstall(payload: {
    moduleId: string;
    scopeUnit?: string;
    keepData?: boolean;
  }): Promise<ModuleUninstallReply> {
    const resp = await this.client.send({
      type: "command",
      action: "modules/uninstall",
      id: this.nextId(),
      payload,
    });
    return resp.payload as ModuleUninstallReply;
  }

  async marketplaceList(): Promise<
    MarketplaceListReply | { kind: "error"; code: string; message: string }
  > {
    const resp = await this.client.send({
      type: "command",
      action: "marketplace/list",
      id: this.nextId(),
    });
    return resp.payload as
      | MarketplaceListReply
      | { kind: "error"; code: string; message: string };
  }

  async marketplaceInfo(moduleId: string): Promise<MarketplaceInfoReply> {
    const resp = await this.client.send({
      type: "command",
      action: "marketplace/info",
      id: this.nextId(),
      payload: { moduleId },
    });
    return resp.payload as MarketplaceInfoReply;
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

// Runtime narrowing for the two genuinely-new RPC replies Phase 13.4.1
// introduces. The other 9 RPC methods on ModuleHostClient inherit their
// shape from dispatcher types that exist pre-flip — their replies pass
// through to existing consumers (CLI, TUI) that already handle the
// legacy error shapes, so a schema drift there surfaces in their
// existing code paths. For the new RPCs (host-call, resolve-panel)
// there is no legacy consumer, so this adapter is the last line of
// defense. Kieran P1-4 on PR #20.

function readHostCallReply(data: unknown): HostCallReply {
  if (!data || typeof data !== "object") {
    return {
      kind: "error",
      code: "HOST_CALL_FAILED",
      message: "modules/host-call reply was not an object",
    };
  }
  const d = data as Record<string, unknown>;
  if (d.kind === "ok") {
    return { kind: "ok", result: d.result };
  }
  if (d.kind === "error") {
    const code = d.code;
    const validCodes = new Set<unknown>([
      "MODULE_UNAVAILABLE",
      "HOST_CAPABILITY_NOT_FOUND_OR_DENIED",
      "HOST_METHOD_NOT_FOUND",
      "HOST_CALL_FAILED",
    ]);
    return {
      kind: "error",
      code: validCodes.has(code)
        ? (code as HostCallReply extends { kind: "error"; code: infer C } ? C : never)
        : "HOST_CALL_FAILED",
      message:
        typeof d.message === "string" ? d.message : "modules/host-call: unknown error",
    };
  }
  return {
    kind: "error",
    code: "HOST_CALL_FAILED",
    message: `modules/host-call: unknown reply shape (kind=${JSON.stringify(d.kind)})`,
  };
}

function readResolvePanelReply(
  data: unknown,
): ResolvePanelReply | ResolvePanelError {
  if (!data || typeof data !== "object") {
    return {
      kind: "error",
      code: "E_PANEL_BAD_REQUEST",
      message: "modules/resolve-panel reply was not an object",
    };
  }
  const d = data as Record<string, unknown>;
  if (d.kind === "error") {
    const code = d.code === "E_PANEL_NOT_FOUND" ? "E_PANEL_NOT_FOUND" : "E_PANEL_BAD_REQUEST";
    return {
      kind: "error",
      code,
      message:
        typeof d.message === "string"
          ? d.message
          : "modules/resolve-panel: unknown error",
    };
  }
  if (
    d.kind === "ok" &&
    typeof d.moduleId === "string" &&
    typeof d.moduleRoot === "string" &&
    d.contribution &&
    typeof d.contribution === "object"
  ) {
    return d as unknown as ResolvePanelReply;
  }
  return {
    kind: "error",
    code: "E_PANEL_BAD_REQUEST",
    message: "modules/resolve-panel: reply missing required fields",
  };
}
