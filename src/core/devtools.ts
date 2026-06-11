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
 * Events (Phase D3 — payloads carry `sessionId` + `worktreeKey`):
 *   'delta'  — { sessionId, worktreeKey, addedIds, updatedIds, evictedIds, meta }
 *   'status' — { sessionId, worktreeKey, meta }
 */

import { EventEmitter } from "node:events";
import { request as httpRequest } from "node:http";
import type { MetroManager } from "./metro.js";
import type { MetroInstance } from "./types.js";
import type { SessionId } from "./identifiers.js";
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

/**
 * Consecutive `/json` poll ticks `proxyStatus` may sit at `"starting"`
 * before the wedge-escape in `pollTargets` reverts it to `"no-target"`.
 * At the default 1s poll interval this is ~10s — far beyond any healthy
 * attach (eager-upstream connect is capped at 3s) but short enough that
 * a wedged session self-heals within one human sigh instead of needing
 * a manual select-target. Exported for tests.
 */
export const STARTING_WEDGE_TICKS = 10;

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

interface SessionState {
  /** Identity dimension. Phase D3 Map key. */
  sessionId: SessionId;
  /**
   * ArtifactStore-hashed worktree key. Metadata after Phase D3; carried
   * forward so emitted events keep the worktreeKey routing dimension
   * MetroLogsStore + downstream consumers rely on.
   */
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
  /**
   * Enable-command failures from the last (re)attach, keyed by CDP
   * method. Cleared on every flush; surfaced via `composeMeta` so a
   * target that ACCEPTS the connection but REFUSES a domain (acme iOS:
   * `Network.enable` → "unavailable when multiple React Native hosts are
   * registered") is diagnosable instead of `connected`-with-empty-buffer.
   */
  enableErrors: Map<string, string>;
  /**
   * Consecutive poll ticks spent in `proxyStatus: "starting"`. The
   * wedge-escape in `pollTargets` reverts to `no-target` once this hits
   * STARTING_WEDGE_TICKS — a hung attach must not disable the recovery
   * branches forever. Reset on any non-starting tick.
   */
  startingTicks: number;
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
  private instances: Map<SessionId, SessionState> = new Map();
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
    sessionId: SessionId;
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
   * Start the DevTools proxy for a session. Throws if Metro isn't running
   * for that session, if no ports can be bound, or if /json cannot be
   * fetched after retries.
   *
   * Phase D3 — keyed by `SessionId`; the metadata `worktreeKey` is
   * lifted off the resolved `MetroInstance` (`instance.worktree`) so
   * emitted devtools events keep the worktree routing dimension that
   * MetroLogsStore + the supervisor's fan-out layer rely on.
   */
  async start(
    sessionId: SessionId
  ): Promise<{ proxyPort: number; sessionNonce: string }> {
    if (this.instances.has(sessionId)) {
      throw new Error(`DevToolsManager: already started for session ${sessionId}`);
    }
    const metroInstance = this.metro.getInstance?.(sessionId) as
      | MetroInstance
      | undefined;
    if (!metroInstance) {
      throw new Error(
        `DevToolsManager: no Metro instance for session ${sessionId}`
      );
    }
    const worktreeKey = metroInstance.worktree;

    const targets = await fetchTargets(metroInstance.port);
    const selected = pickTarget(targets);

    const taps = this.tapFactories.map((f) => f(this.opts));
    const networkTap = findNetworkTap(taps);

    const partial: Partial<SessionState> = {
      sessionId,
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
      enableErrors: new Map(),
      startingTicks: 0,
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
      const state: SessionState = {
        ...(partial as SessionState),
        proxy,
        proxyPort: port,
        sessionNonce: nonce,
        proxyStatus: "no-target",
        state: "IDLE",
      };
      this.instances.set(sessionId, state);
      this.startDeltaTimer(state);
      this.startTargetPolling(state);
      this.emitStatus(state);
      return { proxyPort: port, sessionNonce: nonce };
    }

    const proxy = new CdpProxy({
      upstreamUrl: selected.webSocketDebuggerUrl,
      eagerUpstream: true,
      onEvent: (evt) => this.handleCdpEvent(sessionId, evt),
      onUpstreamOpen: () => this.onUpstreamOpen(sessionId),
      onUpstreamClose: (code, reason) =>
        this.onUpstreamClose(sessionId, code, reason),
      onError: () => {
        // Non-fatal errors are swallowed for MVP. Logged via onError in
        // future iterations.
      },
    });
    const { port, nonce } = await proxy.start();
    const state: SessionState = {
      ...(partial as SessionState),
      proxy,
      proxyPort: port,
      sessionNonce: nonce,
      state: "ATTACHING",
      proxyStatus: "starting",
    };
    this.instances.set(sessionId, state);

    // Attach every tap + flush their enable commands. Errors here are
    // non-fatal — the proxy remains up even if an enable fails — but they
    // ARE recorded (see flushEnableCommands).
    const dispatch: TapDispatch = {
      sendCommand: (cmd, timeoutMs) => proxy.sendCommand(cmd, timeoutMs),
    };
    for (const tap of taps) {
      tap.attach(dispatch);
    }
    this.flushEnableCommands(state, proxy);

    state.state = "RUNNING";
    state.proxyStatus = "connected";
    this.startDeltaTimer(state);
    this.startTargetPolling(state);
    this.emitStatus(state);

    return { proxyPort: port, sessionNonce: nonce };
  }

  async stop(sessionId: SessionId): Promise<void> {
    const state = this.instances.get(sessionId);
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
    this.instances.delete(sessionId);
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
    sessionId: SessionId,
  ): Promise<{ proxyPort: number; sessionNonce: string }> {
    await this.stop(sessionId);
    return this.start(sessionId);
  }

  async stopAll(): Promise<void> {
    const keys = Array.from(this.instances.keys());
    await Promise.all(keys.map((k) => this.stop(k)));
  }

  // -------------------------------------------------------------------------
  // Target control
  // -------------------------------------------------------------------------

  listTargets(sessionId: SessionId): TargetDescriptor[] {
    return this.instances.get(sessionId)?.targets ?? [];
  }

  async selectTarget(sessionId: SessionId, targetId: string): Promise<void> {
    const state = this.instances.get(sessionId);
    if (!state) throw new Error(`DevToolsManager: unknown session ${sessionId}`);
    const target = state.targets.find((t) => t.id === targetId);
    if (!target) {
      throw new Error(
        `DevToolsManager: target ${targetId} not found for session ${sessionId}`
      );
    }
    if (state.selectedTargetId === targetId && state.proxy.handle.isUpstreamOpen) {
      // Re-selecting the already-selected target over a LIVE upstream is a
      // re-arm request, not a no-op. After a Hermes reload the inspector ws
      // bounces and reopens on the SAME target, but CDP domain state
      // (Network.enable) does not survive the new connection — capture
      // silently stops. The UI/agent re-selects to recover; re-flush each
      // tap's enable commands so capture comes back without a full proxy
      // teardown.
      //
      // The `isUpstreamOpen` guard exists because this shortcut is
      // guaranteed dead when the upstream socket has closed —
      // `sendCommand` rejects with `upstream-not-open` before anything
      // reaches the wire. iOS suspend/resume hits exactly that shape: the
      // app suspends (upstream closes, target delisted), then resumes and
      // re-registers under the SAME target id. Pre-guard, the re-select
      // "succeeded" while flushing enables into a dead socket and the
      // session stayed `no-target` forever. Fall through to the full
      // re-dial below instead.
      this.flushEnableCommands(state, state.proxy);
      return;
    }

    // Bump ring epoch for every tap's ring. `target-swap` for a genuine
    // swap; `proxy-restart` when re-dialing the SAME target over a dead
    // upstream (capture continuity is broken either way — CDP re-enables
    // reset request ids).
    const boundaryReason =
      state.selectedTargetId === targetId ? "proxy-restart" : "target-swap";
    for (const tap of state.taps) {
      tap.ring.markSessionBoundary(boundaryReason);
    }
    state.lastSnapshot.clear();
    state.dirty = { added: new Set(), updated: new Set(), evicted: new Set() };

    state.selectedTargetId = targetId;
    state.selectedTarget = target;

    await this.attachProxyToTarget(state, target);
  }

  /**
   * Replace the session's proxy with a fresh one dialed at `target` and
   * re-attach every tap. Shared by `selectTarget` (swap / dead-upstream
   * re-dial) and `pollTargets`' reconnect-on-reappear recovery — the
   * Fusebox URL rewrite layer (Phase 2) reflects the new `sessionNonce`.
   */
  private async attachProxyToTarget(
    state: SessionState,
    target: TargetDescriptor
  ): Promise<void> {
    const sessionId = state.sessionId;
    await state.proxy.stop();
    const newProxy = new CdpProxy({
      upstreamUrl: target.webSocketDebuggerUrl,
      eagerUpstream: true,
      onEvent: (evt) => this.handleCdpEvent(sessionId, evt),
      onUpstreamOpen: () => this.onUpstreamOpen(sessionId),
      onUpstreamClose: (code, reason) =>
        this.onUpstreamClose(sessionId, code, reason),
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
    }
    this.flushEnableCommands(state, newProxy);
    this.emitStatus(state);
  }

  /**
   * Send every tap's enable commands down `proxy`, recording failures in
   * `state.enableErrors`. Two failure shapes, both previously swallowed:
   *
   *  - CDP error RESPONSES resolve (`CdpResponse.error`) — a bare
   *    `.catch()` never sees them. The load-bearing case is RN refusing
   *    `Network.enable` with "The Network domain is unavailable when
   *    multiple React Native hosts are registered" (2026-06-11 acme
   *    iOS battle-test): the session reported `connected` while the
   *    buffer stayed empty forever, with zero diagnostics anywhere.
   *  - Transport rejections (`upstream-not-open`, `command-timeout`).
   *
   * Results are recorded only while `state.proxy === proxy` — a re-dial
   * mid-flight must not let the OLD proxy's stragglers overwrite the new
   * attach's slate. Success deletes the method's entry so a recovered
   * domain clears its stale error.
   */
  private flushEnableCommands(state: SessionState, proxy: CdpProxy): void {
    state.enableErrors.clear();
    for (const tap of state.taps) {
      for (const cmd of tap.enableCommands) {
        proxy.sendCommand(cmd, 5000).then(
          (resp) => {
            if (state.proxy !== proxy) return;
            if (!this.instances.has(state.sessionId)) return;
            if (resp.error) {
              state.enableErrors.set(cmd.method, resp.error.message);
              this.emitStatus(state);
            } else {
              state.enableErrors.delete(cmd.method);
            }
          },
          (err: unknown) => {
            if (state.proxy !== proxy) return;
            if (!this.instances.has(state.sessionId)) return;
            const message = err instanceof Error ? err.message : String(err);
            state.enableErrors.set(cmd.method, message);
            this.emitStatus(state);
          }
        );
      }
    }
  }

  // -------------------------------------------------------------------------
  // Query
  // -------------------------------------------------------------------------

  listNetwork(
    sessionId: SessionId,
    filter?: NetworkFilter
  ): CaptureListResult<NetworkEntry> {
    const state = this.instances.get(sessionId);
    if (!state) {
      return {
        entries: [],
        cursorDropped: false,
        meta: emptyMeta("", "no-target", null, this.opts),
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

  getNetwork(sessionId: SessionId, requestId: string): NetworkEntry | null {
    const state = this.instances.get(sessionId);
    if (!state) return null;
    return state.networkTap.ring.get(requestId) ?? null;
  }

  clear(sessionId: SessionId): void {
    const state = this.instances.get(sessionId);
    if (!state) return;
    state.networkTap.ring.clear();
    state.lastSnapshot.clear();
    state.dirty = { added: new Set(), updated: new Set(), evicted: new Set() };
    this.emitStatus(state);
  }

  status(sessionId: SessionId): DevToolsStatus {
    const state = this.instances.get(sessionId);
    if (!state) {
      return {
        meta: emptyMeta("", "no-target", null, this.opts),
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

  /** Build a cursor for the current end-of-buffer in a session. */
  cursor(sessionId: SessionId): NetworkCursor | null {
    const state = this.instances.get(sessionId);
    if (!state) return null;
    return makeNetworkCursor(
      state.networkTap.ring.state.bufferEpoch,
      state.networkTap.ring.state.lastEventSequence
    );
  }

  // -------------------------------------------------------------------------
  // Internal — CDP event dispatch to taps
  // -------------------------------------------------------------------------

  private handleCdpEvent(sessionId: SessionId, evt: CdpEvent): void {
    const state = this.instances.get(sessionId);
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

  private captureVersions(state: SessionState): Map<string, number> {
    const snap = state.networkTap.ring.snapshot();
    const out = new Map<string, number>();
    for (const entry of snap.entries) {
      // RingBuffer internal: version lives on NetworkEntry
      out.set(entry.requestId, entry.version);
    }
    return out;
  }

  private reconcileDirty(
    state: SessionState,
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

  private startDeltaTimer(state: SessionState): void {
    const interval = this.opts.deltaFlushIntervalMs ?? DEFAULTS.deltaFlushIntervalMs;
    state.deltaTimer = setInterval(() => this.flushDelta(state), interval);
    state.deltaTimer.unref?.();
  }

  private stopDeltaTimer(state: SessionState): void {
    if (state.deltaTimer) {
      clearInterval(state.deltaTimer);
      state.deltaTimer = null;
    }
  }

  private flushDelta(state: SessionState): void {
    const { added, updated, evicted } = state.dirty;
    if (added.size === 0 && updated.size === 0 && evicted.size === 0) return;
    const payload = {
      sessionId: state.sessionId,
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

  private onUpstreamOpen(sessionId: SessionId): void {
    const state = this.instances.get(sessionId);
    if (!state) return;
    state.proxyStatus = "connected";
    state.state = "RUNNING";
    this.emitStatus(state);
  }

  private onUpstreamClose(
    sessionId: SessionId,
    code: number,
    reason: string
  ): void {
    void reason;
    const state = this.instances.get(sessionId);
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
  private async checkPreemption(state: SessionState): Promise<void> {
    const metroInstance = this.metro.getInstance?.(state.sessionId) as
      | MetroInstance
      | undefined;
    if (!metroInstance) return;
    const fresh = await fetchTargets(metroInstance.port);
    // State may have changed during the fetch — guard via manager registry.
    if (!this.instances.has(state.sessionId)) return;
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

  private startTargetPolling(state: SessionState): void {
    const interval = this.opts.pollIntervalMs ?? DEFAULTS.pollIntervalMs;
    if (interval <= 0) return; // disabled (used by tests)
    state.pollTimer = setInterval(() => {
      void this.pollTargets(state);
    }, interval);
    state.pollTimer.unref?.();
  }

  private stopTargetPolling(state: SessionState): void {
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
  async pollTargets(state: SessionState): Promise<void> {
    if (!this.instances.has(state.sessionId)) return;
    const metroInstance = this.metro.getInstance?.(state.sessionId) as
      | MetroInstance
      | undefined;
    if (!metroInstance) return;

    const fresh = await fetchTargets(metroInstance.port);
    // State may have changed during the async fetch. Guard via the
    // manager registry — the type system narrows `state.state` and would
    // otherwise complain that STOPPING is "impossible".
    if (!this.instances.has(state.sessionId)) return;

    const prevIds = state.targets.map((t) => t.id).sort().join(",");
    const nextIds = fresh.map((t) => t.id).sort().join(",");
    const changed = prevIds !== nextIds;

    if (changed) {
      state.targets = fresh;
    }

    // Wedge escape (2026-06-11 acme battle-test): `starting` is the
    // re-entrancy guard both arm branches below set before dispatching
    // an async attach. If that attach hangs — observed live when the
    // app was being reinstalled mid-build, leaving a half-dead inspector
    // page — nothing ever resets the status, and BOTH recovery branches
    // skip on `starting` forever: a permanent wedge only a manual
    // select-target could clear. Count consecutive `starting` ticks and
    // force back to `no-target` after the deadline so the arm branches
    // (same tick, below) can immediately retry.
    if (state.proxyStatus === "starting") {
      state.startingTicks += 1;
      if (state.startingTicks >= STARTING_WEDGE_TICKS) {
        state.startingTicks = 0;
        state.proxyStatus = "no-target";
        this.emitStatus(state);
        // fall through — recovery branches below may re-arm this tick
      }
    } else {
      state.startingTicks = 0;
    }

    // Auto-arm: select + enable capture the instant an app first connects.
    // The CDP Network domain only records requests AFTER `Network.enable`,
    // and an app's launch API burst fires within a second or two of the
    // Hermes target registering. Waiting for a client to manually
    // select-target adds a poll + RPC round-trip that routinely loses that
    // race, so the buffer comes up empty and an idle app makes nothing
    // more. Auto-selecting the default target here closes the gap — a
    // network-capture module should capture from the moment it can. Only
    // fires for the FIRST target when nothing is selected yet; the user or
    // agent can still switch targets afterward. `proxyStatus = "starting"`
    // guards against a re-entrant poll tick double-firing selectTarget.
    if (
      state.selectedTargetId === null &&
      state.proxyStatus === "no-target" &&
      fresh.length > 0
    ) {
      const def = pickTarget(fresh);
      if (def) {
        state.proxyStatus = "starting";
        void this.selectTarget(state.sessionId, def.id).catch(() => {
          const s = this.instances.get(state.sessionId);
          if (s && s.selectedTargetId === null) s.proxyStatus = "no-target";
        });
        return;
      }
    }

    // Reconnect-on-reappear: the previously selected target dropped
    // (upstream closed, `checkPreemption` delisted it → `no-target`) and
    // has now re-registered under the SAME id. iOS suspend/resume is the
    // canonical shape — the device suspends the app (inspector socket
    // closes, target delisted from `/json`), then resume re-registers the
    // identical device-hash/page id. The auto-arm branch above never
    // fires for it (`selectedTargetId` is not null), and select-target's
    // same-id shortcut used to flush enables into the dead socket — so
    // pre-fix, the session sat in `no-target` permanently. Re-dial the
    // stale selection the moment `/json` lists it again. Scoped to
    // `no-target` only: `preempted` means another frontend owns the
    // target, and auto-redialing would fight it.
    if (state.selectedTargetId !== null && state.proxyStatus === "no-target") {
      const reappeared = fresh.find((t) => t.id === state.selectedTargetId);
      if (reappeared) {
        state.proxyStatus = "starting"; // re-entrancy guard (same as auto-arm)
        for (const tap of state.taps) {
          tap.ring.markSessionBoundary("proxy-restart");
        }
        state.lastSnapshot.clear();
        state.dirty = { added: new Set(), updated: new Set(), evicted: new Set() };
        state.selectedTarget = reappeared;
        void this.attachProxyToTarget(state, reappeared).catch(() => {
          const s = this.instances.get(state.sessionId);
          if (s) s.proxyStatus = "no-target";
        });
        return;
      }
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
    sessionId: SessionId;
    worktreeKey: string;
    status: string;
  }): void {
    const state = this.instances.get(payload.sessionId);
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

  private emitStatus(state: SessionState): void {
    this.emit("status", {
      sessionId: state.sessionId,
      worktreeKey: state.worktreeKey,
      meta: this.composeMeta(state),
    });
  }

  // -------------------------------------------------------------------------
  // Meta composition
  // -------------------------------------------------------------------------

  private composeMeta(state: SessionState): CaptureMeta {
    const ringState = state.networkTap.ring.state;
    const bodyCapture: BodyCaptureMode = state.bodyCaptureEnabled
      ? "full"
      : "metadata-only";
    const meta: CaptureMeta = {
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
    if (state.enableErrors.size > 0) {
      meta.enableErrors = Array.from(state.enableErrors, ([method, message]) => ({
        method,
        message,
      }));
    }
    return meta;
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
