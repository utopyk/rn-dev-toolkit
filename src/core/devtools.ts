/**
 * DevToolsManager — per-worktree orchestrator for the agent-native DevTools
 * module. Mirrors the `MetroManager` pattern (class extends EventEmitter,
 * Map of per-worktree state, events for consumers).
 *
 * Responsibilities:
 *   - Lifecycle per worktree (start / stop) with explicit state machine.
 *   - Owns one CdpProxy per worktree.
 *   - Registry of `DomainTap` instances (NetworkTap is the only built-in for
 *     Phase 1; Console/Performance follow).
 *   - Target discovery via Metro `/json`.
 *   - Query API: listNetwork / getNetwork / clear / selectTarget / status.
 *   - Coalesced delta emit every 100 ms.
 *
 * Events:
 *   'delta'  — { worktreeKey, addedIds, updatedIds, evictedIds, meta }
 *   'status' — { worktreeKey, meta }
 */

import { EventEmitter } from "node:events";
import { request as httpRequest } from "node:http";
import type { MetroManager } from "./metro.js";
import type { MetroInstance } from "./types.js";
import { CdpProxy } from "./devtools/proxy.js";
import { NetworkTap } from "./devtools/network-tap.js";
import type {
  AnyDomainTap,
  CdpEvent,
  TapDispatch,
} from "./devtools/domain-tap.js";
import {
  DEFAULTS,
  type BodyCaptureMode,
  type CaptureListResult,
  type CaptureMeta,
  type DevToolsOpts,
  type DevToolsStatus,
  type NetworkCursor,
  type NetworkEntry,
  type NetworkFilter,
  type ProxyStatus,
  type TargetDescriptor,
  makeNetworkCursor,
} from "./devtools/types.js";

// ---------------------------------------------------------------------------
// Per-worktree state
// ---------------------------------------------------------------------------

type ManagerState =
  | "IDLE"
  | "STARTING"
  | "ATTACHING"
  | "RUNNING"
  | "RECONNECTING"
  | "STOPPING";

interface WorktreeState {
  worktreeKey: string;
  proxy: CdpProxy;
  /**
   * Every tap registered for this worktree. Iterated for attach/detach,
   * enable-command flushing, session-boundary propagation, and event
   * dispatch. Adding a new tap (Console, Performance, ...) means appending
   * a factory via `DevToolsManager.registerTap(...)` — the manager's
   * lifecycle code below is tap-agnostic.
   */
  taps: AnyDomainTap[];
  /**
   * Typed pointer to the always-registered NetworkTap. Derived from `taps`
   * at start() time. Network-specific query APIs (`listNetwork`,
   * `getNetwork`, `clear`, `cursor`) narrow via this field. Console /
   * Performance taps surface their queries through their own manager
   * methods (additive per plan §Success Metrics).
   */
  networkTap: NetworkTap;
  state: ManagerState;
  proxyPort: number;
  sessionNonce: string;
  targets: TargetDescriptor[];
  selectedTargetId: string | null;
  selectedTarget: TargetDescriptor | null;
  proxyStatus: ProxyStatus;
  deltaTimer: ReturnType<typeof setInterval> | null;
  /**
   * Periodic `/json` poll — tracks target availability without requiring
   * the UI to click Reconnect. Also the trigger for preemption detection:
   * after an unexpected upstream close we kick an immediate poll, and if
   * the target is still listed in `/json` we mark `proxyStatus: 'preempted'`
   * because someone else must be holding the upstream open.
   */
  pollTimer: ReturnType<typeof setInterval> | null;
  bodyCaptureEnabled: boolean;
  /** Snapshot of ring state at last delta — used to compute deltas. */
  lastSnapshot: Map<string, number>; // id -> version
  /** Accumulated since last flush. */
  dirty: { added: Set<string>; updated: Set<string>; evicted: Set<string> };
}

// ---------------------------------------------------------------------------
// DevToolsManager
// ---------------------------------------------------------------------------

/**
 * Builds a fresh tap instance for a worktree. Invoked once per `start()` per
 * worktree — each worktree owns its own ring buffers and body queues, so tap
 * state is never shared across worktrees.
 */
export type TapFactory = (opts: DevToolsOpts) => AnyDomainTap;

export class DevToolsManager extends EventEmitter {
  private instances: Map<string, WorktreeState> = new Map();
  /**
   * Tap factories, invoked in order for each worktree on `start()`. The
   * built-in NetworkTap factory is seeded first and is always present. Adding
   * a new DomainTap is a single `registerTap(factory)` call — the manager's
   * lifecycle methods below iterate this array and never name concrete taps
   * (NetworkTap is the only exception: it has bespoke query APIs on the
   * manager — legitimately domain-specific).
   */
  private readonly tapFactories: TapFactory[] = [
    (opts) => new NetworkTap(opts),
  ];
  private readonly metroStatusListener: (payload: {
    worktreeKey: string;
    status: string;
  }) => void;

  constructor(
    private readonly metro: MetroManager,
    private readonly opts: DevToolsOpts = {}
  ) {
    super();
    // Subscribe to Metro status to react to restarts. Held as a field so
    // dispose() can remove it and avoid leaking listeners when the manager
    // is rebuilt (e.g. on Metro retry).
    this.metroStatusListener = (payload) => this.onMetroStatus(payload);
    this.metro.on("status", this.metroStatusListener);
  }

  /**
   * Register an additional DomainTap factory. Must be called before `start()`
   * for a worktree — already-running worktrees do not retroactively acquire
   * the new tap.
   */
  registerTap(factory: TapFactory): void {
    this.tapFactories.push(factory);
  }

  /**
   * Full teardown: stop every worktree and release the Metro status
   * subscription. After dispose() the manager must not be reused.
   */
  async dispose(): Promise<void> {
    await this.stopAll();
    this.metro.off("status", this.metroStatusListener);
    this.removeAllListeners();
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  /**
   * Start the DevTools proxy for a worktree. Throws if Metro isn't running
   * for that worktree, if no ports can be bound, or if /json cannot be
   * fetched after retries.
   */
  async start(
    worktreeKey: string
  ): Promise<{ proxyPort: number; sessionNonce: string }> {
    if (this.instances.has(worktreeKey)) {
      throw new Error(`DevToolsManager: already started for ${worktreeKey}`);
    }
    const metroInstance = this.metro.getInstance?.(worktreeKey) as
      | MetroInstance
      | undefined;
    if (!metroInstance) {
      throw new Error(
        `DevToolsManager: no Metro instance for worktree ${worktreeKey}`
      );
    }

    const targets = await fetchTargets(metroInstance.port);
    const selected = pickTarget(targets);

    const taps = this.tapFactories.map((f) => f(this.opts));
    const networkTap = findNetworkTap(taps);

    const partial: Partial<WorktreeState> = {
      worktreeKey,
      taps,
      networkTap,
      state: "STARTING",
      proxyStatus: "starting",
      selectedTargetId: selected?.id ?? null,
      selectedTarget: selected,
      targets,
      bodyCaptureEnabled: this.opts.captureBodies ?? DEFAULTS.captureBodies,
      deltaTimer: null,
      pollTimer: null,
      lastSnapshot: new Map(),
      dirty: { added: new Set(), updated: new Set(), evicted: new Set() },
    };

    if (!selected) {
      // No target — still create the proxy state in a 'no-target' posture so
      // subsequent list() calls surface the status cleanly. `/json` polling
      // is what brings us out of this state once a target appears.
      const proxy = new CdpProxy({
        // We don't have a real URL yet; use a placeholder. `start` will skip
        // upstream eager open since we can't connect.
        upstreamUrl: `ws://127.0.0.1:${metroInstance.port}/inspector/no-target`,
      });
      const { port, nonce } = await proxy.start();
      const state: WorktreeState = {
        ...(partial as WorktreeState),
        proxy,
        proxyPort: port,
        sessionNonce: nonce,
        proxyStatus: "no-target",
        state: "IDLE",
      };
      this.instances.set(worktreeKey, state);
      this.startDeltaTimer(state);
      this.startTargetPolling(state);
      this.emitStatus(state);
      return { proxyPort: port, sessionNonce: nonce };
    }

    const proxy = new CdpProxy({
      upstreamUrl: selected.webSocketDebuggerUrl,
      eagerUpstream: true,
      onEvent: (evt) => this.handleCdpEvent(worktreeKey, evt),
      onUpstreamOpen: () => this.onUpstreamOpen(worktreeKey),
      onUpstreamClose: (code, reason) =>
        this.onUpstreamClose(worktreeKey, code, reason),
      onError: () => {
        // Non-fatal errors are swallowed for MVP. Logged via onError in
        // future iterations.
      },
    });
    const { port, nonce } = await proxy.start();
    const state: WorktreeState = {
      ...(partial as WorktreeState),
      proxy,
      proxyPort: port,
      sessionNonce: nonce,
      state: "ATTACHING",
      proxyStatus: "starting",
    };
    this.instances.set(worktreeKey, state);

    // Attach every tap + flush their enable commands. Errors here are
    // non-fatal — the proxy remains up even if an enable fails.
    const dispatch: TapDispatch = {
      sendCommand: (cmd, timeoutMs) => proxy.sendCommand(cmd, timeoutMs),
    };
    for (const tap of taps) {
      tap.attach(dispatch);
      for (const cmd of tap.enableCommands) {
        proxy.sendCommand(cmd, 5000).catch(() => {
          // Swallow — capability is probed by event arrival, not cmd success.
        });
      }
    }

    state.state = "RUNNING";
    state.proxyStatus = "connected";
    this.startDeltaTimer(state);
    this.startTargetPolling(state);
    this.emitStatus(state);

    return { proxyPort: port, sessionNonce: nonce };
  }

  async stop(worktreeKey: string): Promise<void> {
    const state = this.instances.get(worktreeKey);
    if (!state) return;
    state.state = "STOPPING";
    this.stopDeltaTimer(state);
    this.stopTargetPolling(state);
    for (const tap of state.taps) {
      try {
        tap.detach();
      } catch {
        // tap errors shouldn't block teardown
      }
    }
    await state.proxy.stop();
    this.instances.delete(worktreeKey);
  }

  /**
   * Stop the worktree's proxy + start a fresh one. Used by the Electron
   * "Reconnect" / "Retry target discovery" button when the manager has
   * landed in `no-target` and the user wants to rediscover after the
   * app launches.
   *
   * The composition lives at the manager layer (not in the daemon's
   * RPC dispatcher) because per-worktree state-machine ownership is
   * the manager's job — exposing `stop`+`start` as two separate RPCs
   * would let a concurrent caller observe the empty-meta gap between
   * them. Architecture P1-2 on PR #26.
   */
  async restart(
    worktreeKey: string,
  ): Promise<{ proxyPort: number; sessionNonce: string }> {
    await this.stop(worktreeKey);
    return this.start(worktreeKey);
  }

  async stopAll(): Promise<void> {
    const keys = Array.from(this.instances.keys());
    await Promise.all(keys.map((k) => this.stop(k)));
  }

  // -------------------------------------------------------------------------
  // Target control
  // -------------------------------------------------------------------------

  listTargets(worktreeKey: string): TargetDescriptor[] {
    return this.instances.get(worktreeKey)?.targets ?? [];
  }

  async selectTarget(worktreeKey: string, targetId: string): Promise<void> {
    const state = this.instances.get(worktreeKey);
    if (!state) throw new Error(`DevToolsManager: unknown worktree ${worktreeKey}`);
    const target = state.targets.find((t) => t.id === targetId);
    if (!target) {
      throw new Error(
        `DevToolsManager: target ${targetId} not found for ${worktreeKey}`
      );
    }
    if (state.selectedTargetId === targetId) return;

    // Bump ring epoch with target-swap reason for every tap's ring.
    for (const tap of state.taps) {
      tap.ring.markSessionBoundary("target-swap");
    }
    state.lastSnapshot.clear();
    state.dirty = { added: new Set(), updated: new Set(), evicted: new Set() };

    state.selectedTargetId = targetId;
    state.selectedTarget = target;

    // Replace the proxy with one pointing at the new target. Fusebox URL
    // rewrite layer (Phase 2) will reflect the new `sessionNonce`.
    await state.proxy.stop();
    const newProxy = new CdpProxy({
      upstreamUrl: target.webSocketDebuggerUrl,
      eagerUpstream: true,
      onEvent: (evt) => this.handleCdpEvent(worktreeKey, evt),
      onUpstreamOpen: () => this.onUpstreamOpen(worktreeKey),
      onUpstreamClose: (code, reason) =>
        this.onUpstreamClose(worktreeKey, code, reason),
    });
    const { port, nonce } = await newProxy.start();
    state.proxy = newProxy;
    state.proxyPort = port;
    state.sessionNonce = nonce;
    state.state = "RUNNING";
    state.proxyStatus = "connected";

    // Re-attach every tap to the new proxy + re-flush enable commands.
    const dispatch: TapDispatch = {
      sendCommand: (cmd, timeoutMs) => newProxy.sendCommand(cmd, timeoutMs),
    };
    for (const tap of state.taps) {
      try {
        tap.detach();
      } catch {
        // best-effort
      }
      tap.attach(dispatch);
      for (const cmd of tap.enableCommands) {
        newProxy.sendCommand(cmd, 5000).catch(() => {
          // non-fatal
        });
      }
    }
    this.emitStatus(state);
  }

  // -------------------------------------------------------------------------
  // Query
  // -------------------------------------------------------------------------

  listNetwork(
    worktreeKey: string,
    filter?: NetworkFilter
  ): CaptureListResult<NetworkEntry> {
    const state = this.instances.get(worktreeKey);
    if (!state) {
      return {
        entries: [],
        cursorDropped: false,
        meta: emptyMeta(worktreeKey, "no-target", null, this.opts),
      };
    }
    const ring = state.networkTap.ring;
    const since = filter?.since;
    // Validate cursor belongs to current epoch. Epoch mismatch = cursor
    // belongs to a prior session; treat as `cursorDropped`.
    const sinceSequence =
      since && since.bufferEpoch === ring.state.bufferEpoch
        ? since.sequence
        : undefined;
    const snap = ring.snapshot({ sinceSequence });
    let entries = snap.entries as readonly NetworkEntry[];
    let cursorDropped = snap.cursorDropped;
    if (since && since.bufferEpoch !== ring.state.bufferEpoch) {
      cursorDropped = true;
    }

    // Apply filter
    if (filter) {
      if (filter.urlRegex) {
        const re = new RegExp(filter.urlRegex);
        entries = entries.filter((e) => re.test(e.url));
      }
      if (filter.methods && filter.methods.length > 0) {
        const s = new Set(filter.methods.map((m) => m.toUpperCase()));
        entries = entries.filter((e) => s.has(e.method.toUpperCase()));
      }
      if (filter.statusRange) {
        const [lo, hi] = filter.statusRange;
        entries = entries.filter(
          (e) => e.terminalState === "finished" && e.status >= lo && e.status <= hi
        );
      }
      if (filter.limit && filter.limit > 0) {
        entries = entries.slice(-filter.limit);
      }
    }

    return {
      entries,
      cursorDropped,
      meta: this.composeMeta(state),
    };
  }

  getNetwork(worktreeKey: string, requestId: string): NetworkEntry | null {
    const state = this.instances.get(worktreeKey);
    if (!state) return null;
    return state.networkTap.ring.get(requestId) ?? null;
  }

  clear(worktreeKey: string): void {
    const state = this.instances.get(worktreeKey);
    if (!state) return;
    state.networkTap.ring.clear();
    state.lastSnapshot.clear();
    state.dirty = { added: new Set(), updated: new Set(), evicted: new Set() };
    this.emitStatus(state);
  }

  status(worktreeKey: string): DevToolsStatus {
    const state = this.instances.get(worktreeKey);
    if (!state) {
      return {
        meta: emptyMeta(worktreeKey, "no-target", null, this.opts),
        targets: [],
        rnVersion: null,
        proxyPort: null,
        sessionNonce: null,
        bodyCaptureEnabled: this.opts.captureBodies ?? DEFAULTS.captureBodies,
      };
    }
    return {
      meta: this.composeMeta(state),
      targets: state.targets,
      rnVersion: null, // TODO Phase 2: read from package.json at project root
      proxyPort: state.proxyPort,
      sessionNonce: state.sessionNonce,
      bodyCaptureEnabled: state.bodyCaptureEnabled,
    };
  }

  /** Build a cursor for the current end-of-buffer in a worktree. */
  cursor(worktreeKey: string): NetworkCursor | null {
    const state = this.instances.get(worktreeKey);
    if (!state) return null;
    return makeNetworkCursor(
      state.networkTap.ring.state.bufferEpoch,
      state.networkTap.ring.state.lastEventSequence
    );
  }

  // -------------------------------------------------------------------------
  // Internal — CDP event dispatch to taps
  // -------------------------------------------------------------------------

  private handleCdpEvent(worktreeKey: string, evt: CdpEvent): void {
    const state = this.instances.get(worktreeKey);
    if (!state) return;
    // Dispatch to every tap whose domain matches the event's prefix. One
    // event may match at most one tap (domains are disjoint) but we iterate
    // rather than branching to keep this loop tap-agnostic.
    //
    // Delta tracking is currently Network-only — `captureVersions` and
    // `reconcileDirty` inspect the NetworkTap ring. When Phase 3+ lands a
    // real second tap with consumer-visible deltas (Console), this block
    // becomes per-tap. The per-tap-delta refactor touches only this file,
    // not proxy.ts — the seam still holds.
    const prevVersions = this.captureVersions(state);
    for (const tap of state.taps) {
      if (!evt.method.startsWith(`${tap.domain}.`)) continue;
      try {
        tap.handleEvent(evt);
      } catch {
        // tap errors shouldn't bring down the proxy
      }
    }
    this.reconcileDirty(state, prevVersions);
  }

  private captureVersions(state: WorktreeState): Map<string, number> {
    const snap = state.networkTap.ring.snapshot();
    const out = new Map<string, number>();
    for (const entry of snap.entries) {
      // RingBuffer internal: version lives on NetworkEntry
      out.set(entry.requestId, entry.version);
    }
    return out;
  }

  private reconcileDirty(
    state: WorktreeState,
    before: Map<string, number>
  ): void {
    const after = this.captureVersions(state);
    for (const [id, v] of after) {
      const prev = before.get(id);
      if (prev === undefined) {
        state.dirty.added.add(id);
        continue;
      }
      if (prev !== v) {
        state.dirty.updated.add(id);
      }
    }
    for (const id of before.keys()) {
      if (!after.has(id)) {
        state.dirty.evicted.add(id);
        state.dirty.added.delete(id);
        state.dirty.updated.delete(id);
      }
    }
  }

  // -------------------------------------------------------------------------
  // Delta flush
  // -------------------------------------------------------------------------

  private startDeltaTimer(state: WorktreeState): void {
    const interval = this.opts.deltaFlushIntervalMs ?? DEFAULTS.deltaFlushIntervalMs;
    state.deltaTimer = setInterval(() => this.flushDelta(state), interval);
    state.deltaTimer.unref?.();
  }

  private stopDeltaTimer(state: WorktreeState): void {
    if (state.deltaTimer) {
      clearInterval(state.deltaTimer);
      state.deltaTimer = null;
    }
  }

  private flushDelta(state: WorktreeState): void {
    const { added, updated, evicted } = state.dirty;
    if (added.size === 0 && updated.size === 0 && evicted.size === 0) return;
    const payload = {
      worktreeKey: state.worktreeKey,
      addedIds: Array.from(added),
      updatedIds: Array.from(updated),
      evictedIds: Array.from(evicted),
      meta: this.composeMeta(state),
    };
    state.dirty = { added: new Set(), updated: new Set(), evicted: new Set() };
    this.emit("delta", payload);
  }

  // -------------------------------------------------------------------------
  // Status / upstream callbacks
  // -------------------------------------------------------------------------

  private onUpstreamOpen(worktreeKey: string): void {
    const state = this.instances.get(worktreeKey);
    if (!state) return;
    state.proxyStatus = "connected";
    state.state = "RUNNING";
    this.emitStatus(state);
  }

  private onUpstreamClose(
    worktreeKey: string,
    code: number,
    reason: string
  ): void {
    void reason;
    const state = this.instances.get(worktreeKey);
    if (!state) return;
    if (state.state === "STOPPING") return; // ours
    state.proxyStatus = "disconnected";
    state.state = "RECONNECTING";
    this.emitStatus(state);

    // Preemption detection (plan §Shared-Device Contention). Hermes close
    // codes 1006 / 1012 are the common "something kicked us" signals. If
    // `/json` still lists our target right after the close, someone else is
    // already attached — mark `'preempted'` so the UI can stop pestering
    // with reconnect prompts. If the target is gone, it's a reload /
    // Hermes restart — stay `'no-target'` until polling picks up a new
    // target.
    //
    // `void code` for readability: we use the close as a signal, not the
    // specific code — the `/json` response is the authoritative check.
    void code;
    void this.checkPreemption(state);
  }

  /**
   * Immediate `/json` poll triggered by an unexpected upstream close.
   * Runs independently of the scheduled poll loop so the user sees a
   * useful status within ~2s instead of waiting for the next tick.
   */
  private async checkPreemption(state: WorktreeState): Promise<void> {
    const metroInstance = this.metro.getInstance?.(state.worktreeKey) as
      | MetroInstance
      | undefined;
    if (!metroInstance) return;
    const fresh = await fetchTargets(metroInstance.port);
    // State may have changed during the fetch — guard via manager registry.
    if (!this.instances.has(state.worktreeKey)) return;
    const stillListed = state.selectedTargetId
      ? fresh.some((t) => t.id === state.selectedTargetId)
      : false;
    state.targets = fresh;
    state.proxyStatus = stillListed ? "preempted" : "no-target";
    this.emitStatus(state);
  }

  // -------------------------------------------------------------------------
  // `/json` polling — target discovery + Hermes reload detection
  // -------------------------------------------------------------------------

  private startTargetPolling(state: WorktreeState): void {
    const interval = this.opts.pollIntervalMs ?? DEFAULTS.pollIntervalMs;
    if (interval <= 0) return; // disabled (used by tests)
    state.pollTimer = setInterval(() => {
      void this.pollTargets(state);
    }, interval);
    state.pollTimer.unref?.();
  }

  private stopTargetPolling(state: WorktreeState): void {
    if (state.pollTimer) {
      clearInterval(state.pollTimer);
      state.pollTimer = null;
    }
  }

  /**
   * Refresh `state.targets` from Metro `/json`. Called on an interval
   * (`startTargetPolling`) while a worktree is running. Pure inspection:
   * this method does NOT reattach or bump epoch — it only surfaces
   * discovery events to consumers. The Electron and Ink surfaces decide
   * whether to offer the new target; the agent sees it via
   * `devtools-status`.
   *
   * One side effect worth naming: if the previously selected target has
   * disappeared and proxyStatus is currently `'connected'`, we downgrade
   * to `'no-target'`. (Hermes reloads can break the websocket silently
   * in some RN versions — the `/json` poll is the authoritative check.)
   */
  async pollTargets(state: WorktreeState): Promise<void> {
    if (!this.instances.has(state.worktreeKey)) return;
    const metroInstance = this.metro.getInstance?.(state.worktreeKey) as
      | MetroInstance
      | undefined;
    if (!metroInstance) return;

    const fresh = await fetchTargets(metroInstance.port);
    // State may have changed during the async fetch. Guard via the
    // manager registry — the type system narrows `state.state` and would
    // otherwise complain that STOPPING is "impossible".
    if (!this.instances.has(state.worktreeKey)) return;

    const prevIds = state.targets.map((t) => t.id).sort().join(",");
    const nextIds = fresh.map((t) => t.id).sort().join(",");
    const changed = prevIds !== nextIds;

    if (changed) {
      state.targets = fresh;
    }

    // If the selected target has vanished and we still thought we were
    // connected, drop to `'no-target'`. Don't override `'preempted'` —
    // that's a stronger signal.
    let statusChanged = false;
    const stillSelected = state.selectedTargetId
      ? fresh.some((t) => t.id === state.selectedTargetId)
      : true;
    if (
      !stillSelected &&
      state.selectedTargetId !== null &&
      state.proxyStatus === "connected"
    ) {
      state.proxyStatus = "no-target";
      statusChanged = true;
    }

    if (changed || statusChanged) this.emitStatus(state);
  }

  private onMetroStatus(payload: {
    worktreeKey: string;
    status: string;
  }): void {
    const state = this.instances.get(payload.worktreeKey);
    if (!state) return;
    if (payload.status === "stopped" || payload.status === "error") {
      for (const tap of state.taps) {
        tap.ring.markSessionBoundary("metro-restart");
      }
      state.proxyStatus = "no-target";
      state.state = "IDLE";
      this.emitStatus(state);
    }
  }

  private emitStatus(state: WorktreeState): void {
    this.emit("status", {
      worktreeKey: state.worktreeKey,
      meta: this.composeMeta(state),
    });
  }

  // -------------------------------------------------------------------------
  // Meta composition
  // -------------------------------------------------------------------------

  private composeMeta(state: WorktreeState): CaptureMeta {
    const ringState = state.networkTap.ring.state;
    const bodyCapture: BodyCaptureMode = state.bodyCaptureEnabled
      ? "full"
      : "metadata-only";
    return {
      worktreeKey: state.worktreeKey,
      bufferEpoch: ringState.bufferEpoch,
      oldestSequence: ringState.oldestSequence,
      lastEventSequence: ringState.lastEventSequence,
      proxyStatus: state.proxyStatus,
      selectedTargetId: state.selectedTargetId,
      evictedCount: ringState.evictedCount,
      tapDroppedCount: ringState.tapDroppedCount,
      bodyTruncatedCount: ringState.bodyTruncatedCount,
      bodyCapture,
      sessionBoundary: ringState.sessionBoundary,
    };
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function emptyMeta(
  worktreeKey: string,
  proxyStatus: ProxyStatus,
  selectedTargetId: string | null,
  opts: DevToolsOpts
): CaptureMeta {
  return {
    worktreeKey,
    bufferEpoch: 1,
    oldestSequence: 1,
    lastEventSequence: 0,
    proxyStatus,
    selectedTargetId,
    evictedCount: 0,
    tapDroppedCount: 0,
    bodyTruncatedCount: 0,
    bodyCapture: (opts.captureBodies ?? DEFAULTS.captureBodies)
      ? "full"
      : "metadata-only",
    sessionBoundary: null,
  };
}

function pickTarget(targets: TargetDescriptor[]): TargetDescriptor | null {
  if (targets.length === 0) return null;
  const nodeTarget = targets.find((t) => t.type === "node");
  return nodeTarget ?? targets[0]!;
}

/**
 * Locate the NetworkTap instance in a worktree's tap list. Network-specific
 * query APIs (`listNetwork`, `getNetwork`, `clear`, `cursor`) narrow via this
 * helper. Throws if the built-in NetworkTap factory was removed — a
 * programmer error, since the manager seeds it in the factory list.
 */
function findNetworkTap(taps: readonly AnyDomainTap[]): NetworkTap {
  const network = taps.find((t): t is NetworkTap => t instanceof NetworkTap);
  if (!network) {
    throw new Error(
      "DevToolsManager: no NetworkTap registered. The built-in NetworkTap factory is seeded by the constructor; do not remove it."
    );
  }
  return network;
}

/**
 * Fetch Metro `/json` target list. Returns [] if Metro isn't responding.
 */
export async function fetchTargets(
  metroPort: number
): Promise<TargetDescriptor[]> {
  return new Promise((resolve) => {
    const req = httpRequest(
      {
        host: "127.0.0.1",
        port: metroPort,
        path: "/json",
        method: "GET",
        timeout: 2000,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => {
          try {
            const body = Buffer.concat(chunks).toString("utf8");
            const parsed = JSON.parse(body) as unknown;
            if (!Array.isArray(parsed)) return resolve([]);
            const targets = parsed
              .map((raw): TargetDescriptor | null => {
                if (typeof raw !== "object" || raw === null) return null;
                const r = raw as Record<string, unknown>;
                const ws = r.webSocketDebuggerUrl;
                const id = r.id;
                if (typeof ws !== "string" || typeof id !== "string") return null;
                return {
                  id,
                  type: typeof r.type === "string" ? r.type : "unknown",
                  title: typeof r.title === "string" ? r.title : "",
                  description:
                    typeof r.description === "string"
                      ? r.description
                      : undefined,
                  url: typeof r.url === "string" ? r.url : undefined,
                  webSocketDebuggerUrl: ws,
                  devtoolsFrontendUrl:
                    typeof r.devtoolsFrontendUrl === "string"
                      ? r.devtoolsFrontendUrl
                      : undefined,
                };
              })
              .filter((t): t is TargetDescriptor => t !== null);
            resolve(targets);
          } catch {
            resolve([]);
          }
        });
      }
    );
    req.on("error", () => resolve([]));
    req.on("timeout", () => {
      req.destroy();
      resolve([]);
    });
    req.end();
  });
}
