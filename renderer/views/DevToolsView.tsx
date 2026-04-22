import React, { useState, useEffect, useRef, useCallback } from 'react';
import { useIpcInvoke, useIpcOn } from '../hooks/useIpc';
import './DevToolsView.css';

interface DevToolsViewProps {
  metroPort: number;
}

interface Target {
  id: string;
  type: string;
  title: string;
  description?: string;
  url?: string;
  webSocketDebuggerUrl: string;
  devtoolsFrontendUrl?: string;
}

interface StatusPayload {
  meta: { proxyStatus: string; selectedTargetId: string | null };
  targets: Target[];
  proxyPort: number | null;
  sessionNonce: string | null;
}

type ConnectionState = 'connecting' | 'no-target' | 'connected' | 'error';

/**
 * Rewrite Fusebox's `ws=` query param to point at our local CDP proxy.
 *
 * Fusebox (like Chrome DevTools frontend) expects `ws=HOST:PORT/PATH` without
 * the `ws://` protocol prefix — it prepends `ws://` internally. Passing a full
 * `ws://...` URL produces `ws://ws://...` and the WebSocket never connects,
 * which manifests as empty/dead subtabs.
 */
function rewriteFuseboxUrl(
  baseHost: string,
  target: Target,
  proxyPort: number,
  sessionNonce: string,
): string | null {
  const proxyWs = `127.0.0.1:${proxyPort}/proxy/${sessionNonce}`;

  if (target.devtoolsFrontendUrl) {
    // Metro returns this as a relative URL like
    // `/debugger-frontend/rn_fusebox.html?ws=...` but some versions return
    // an absolute URL. Handle both.
    const raw = target.devtoolsFrontendUrl;
    const full = /^https?:\/\//i.test(raw) ? raw : `${baseHost}${raw}`;
    try {
      const u = new URL(full);
      u.searchParams.set('ws', proxyWs);
      return u.toString();
    } catch {
      return null;
    }
  }
  if (target.webSocketDebuggerUrl) {
    const qs = new URLSearchParams({
      ws: proxyWs,
      'sources.hide_add_folder': 'true',
    });
    return `${baseHost}/debugger-frontend/rn_fusebox.html?${qs.toString()}`;
  }
  return null;
}

function pickTarget(targets: Target[], preferredId: string | null): Target | null {
  if (targets.length === 0) return null;
  if (preferredId) {
    const match = targets.find(t => t.id === preferredId);
    if (match) return match;
  }
  return targets.find(t => t.type === 'node') ?? targets[0] ?? null;
}

export function DevToolsView({ metroPort }: DevToolsViewProps) {
  const [state, setState] = useState<ConnectionState>('connecting');
  const [devtoolsUrl, setDevtoolsUrl] = useState<string | null>(null);
  const [errorMsg, setErrorMsg] = useState('');
  const [targets, setTargets] = useState<Target[]>([]);
  const [selectedTargetId, setSelectedTargetId] = useState<string | null>(null);
  const invoke = useIpcInvoke();
  const cancelledRef = useRef(false);

  const buildAndSetUrl = useCallback(
    (all: Target[], preferredId: string | null, proxyPort: number, sessionNonce: string) => {
      const target = pickTarget(all, preferredId);
      if (!target) {
        setState('no-target');
        return;
      }
      const baseHost = `http://localhost:${metroPort}`;
      const url = rewriteFuseboxUrl(baseHost, target, proxyPort, sessionNonce);
      if (!url) {
        setState('error');
        setErrorMsg('Unable to construct DevTools URL');
        return;
      }
      setDevtoolsUrl(url);
      setSelectedTargetId(target.id);
      setState('connected');
    },
    [metroPort],
  );

  const connect = useCallback(async () => {
    setState('connecting');
    setDevtoolsUrl(null);
    try {
      const portInfo = await invoke('devtools-network:proxy-port', metroPort) as
        | { proxyPort: number; sessionNonce: string }
        | null;
      if (cancelledRef.current) return;
      if (!portInfo) {
        setState('error');
        setErrorMsg(`Cannot start DevTools proxy for Metro on port ${metroPort}`);
        return;
      }
      const status = await invoke('devtools-network:status', metroPort) as StatusPayload | null;
      if (cancelledRef.current) return;
      if (!status) {
        setState('error');
        setErrorMsg('DevTools manager returned no status');
        return;
      }
      setTargets(status.targets);
      buildAndSetUrl(
        status.targets,
        status.meta.selectedTargetId,
        portInfo.proxyPort,
        portInfo.sessionNonce,
      );
    } catch (err: any) {
      if (cancelledRef.current) return;
      setState('error');
      setErrorMsg(err?.message?.slice(0, 160) ?? `Cannot connect to Metro on port ${metroPort}`);
    }
  }, [metroPort, invoke, buildAndSetUrl]);

  // Restart the proxy (dispose + re-start) — used when the user clicks
  // "Reconnect" from the no-target state, to rediscover targets after the
  // app has launched.
  const restart = useCallback(async () => {
    setState('connecting');
    setDevtoolsUrl(null);
    try {
      const portInfo = await invoke('devtools-network:restart', metroPort) as
        | { proxyPort: number; sessionNonce: string }
        | null;
      if (cancelledRef.current) return;
      if (!portInfo) {
        setState('error');
        setErrorMsg(`Cannot restart DevTools proxy for Metro on port ${metroPort}`);
        return;
      }
      const status = await invoke('devtools-network:status', metroPort) as StatusPayload | null;
      if (cancelledRef.current) return;
      if (!status) {
        setState('error');
        setErrorMsg('DevTools manager returned no status');
        return;
      }
      setTargets(status.targets);
      buildAndSetUrl(
        status.targets,
        status.meta.selectedTargetId,
        portInfo.proxyPort,
        portInfo.sessionNonce,
      );
    } catch (err: any) {
      if (cancelledRef.current) return;
      setState('error');
      setErrorMsg(err?.message?.slice(0, 160) ?? 'Restart failed');
    }
  }, [metroPort, invoke, buildAndSetUrl]);

  const onSelectTarget = useCallback(
    async (targetId: string) => {
      if (targetId === selectedTargetId) return;
      setState('connecting');
      setDevtoolsUrl(null);
      try {
        const res = await invoke('devtools-network:select-target', metroPort, targetId) as
          | { ok: boolean; error?: string }
          | null;
        if (cancelledRef.current) return;
        if (!res?.ok) {
          setState('error');
          setErrorMsg(res?.error ?? 'select-target failed');
          return;
        }
        // selectTarget() swaps the proxy — re-read port/nonce.
        const status = await invoke('devtools-network:status', metroPort) as StatusPayload | null;
        if (cancelledRef.current) return;
        if (!status || status.proxyPort === null || status.sessionNonce === null) {
          setState('error');
          setErrorMsg('DevTools proxy went away after target switch');
          return;
        }
        setTargets(status.targets);
        buildAndSetUrl(status.targets, targetId, status.proxyPort, status.sessionNonce);
      } catch (err: any) {
        if (cancelledRef.current) return;
        setState('error');
        setErrorMsg(err?.message?.slice(0, 160) ?? 'select-target failed');
      }
    },
    [metroPort, invoke, buildAndSetUrl, selectedTargetId],
  );

  // Listen for manager status pushes so we can keep the target list fresh
  // without polling. Ignore events from other instances (same IPC channel is
  // shared across every worktree).
  const onChange = useCallback(
    (payload: { port: number; kind: 'status' | 'delta' }) => {
      if (payload?.port !== metroPort) return;
      if (payload.kind !== 'status') return;
      invoke<StatusPayload | null>('devtools-network:status', metroPort)
        .then((s) => {
          if (cancelledRef.current || !s) return;
          setTargets(s.targets);
        })
        .catch(() => {});
    },
    [metroPort, invoke],
  );
  useIpcOn('devtools-network:change', onChange);

  useEffect(() => {
    cancelledRef.current = false;
    connect();
    return () => {
      cancelledRef.current = true;
    };
  }, [connect]);

  if (state === 'connecting') {
    return (
      <div className="devtools-placeholder">
        <div className="devtools-icon">🔧</div>
        <div className="devtools-title">Connecting to Metro DevTools...</div>
        <div className="devtools-subtitle">Starting CDP proxy and looking for debugger targets on port {metroPort}</div>
      </div>
    );
  }

  if (state === 'no-target') {
    return (
      <div className="devtools-placeholder">
        <div className="devtools-icon">📱</div>
        <div className="devtools-title">Waiting for app to connect</div>
        <div className="devtools-subtitle">
          Metro is running on port {metroPort} but no app is connected yet.
          <br />Launch the app on a device or simulator to see DevTools.
        </div>
        <button className="devtools-toolbar-btn" onClick={() => { void restart(); }}>
          ↻ Retry target discovery
        </button>
        <div className="devtools-hint">
          DevTools will reconnect automatically once the app attaches.
        </div>
      </div>
    );
  }

  if (state === 'error') {
    return (
      <div className="devtools-placeholder">
        <div className="devtools-icon">⚠</div>
        <div className="devtools-title">DevTools unavailable</div>
        <div className="devtools-subtitle">{errorMsg}</div>
        <button className="devtools-toolbar-btn" onClick={() => { void restart(); }}>
          ↻ Retry
        </button>
        <div className="devtools-hint">Make sure Metro is running on port {metroPort}.</div>
      </div>
    );
  }

  return (
    <div className="devtools-container">
      <div className="devtools-toolbar">
        <span className="devtools-toolbar-title">React Native DevTools</span>
        <span className="devtools-toolbar-port">:{metroPort}</span>
        {targets.length > 1 && (
          <select
            className="devtools-target-select"
            value={selectedTargetId ?? ''}
            onChange={e => { void onSelectTarget(e.target.value); }}
          >
            {targets.map(t => (
              <option key={t.id} value={t.id}>
                {t.title || t.type || t.id}
              </option>
            ))}
          </select>
        )}
        <button
          className="devtools-toolbar-btn"
          onClick={() => { void restart(); }}
        >
          ↻ Reconnect
        </button>
        <button
          className="devtools-toolbar-btn"
          onClick={() => {
            if (devtoolsUrl) window.open(devtoolsUrl, '_blank');
          }}
        >
          ↗ Pop Out
        </button>
      </div>
      <webview
        src={devtoolsUrl!}
        className="devtools-webview"
        // @ts-ignore — webview is an Electron-specific element
        allowpopups="true"
      />
    </div>
  );
}
