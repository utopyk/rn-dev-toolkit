import React, { useCallback, useEffect, useState } from 'react';
import { useIpcInvoke } from '../hooks/useIpc';
import './WelcomeScreen.css';

interface ProjectRef {
  path: string;
  name: string;
}

interface RecentProjectView extends ProjectRef {
  lastOpenedAt: string;
  exists: boolean;
}

interface ProjectListReply {
  current: ProjectRef | null;
  recents: RecentProjectView[];
  detected: ProjectRef | null;
}

interface OpenReply {
  ok: boolean;
  path?: string;
  name?: string;
  error?: string;
  canceled?: boolean;
}

interface WelcomeScreenProps {
  /**
   * Return to the running app without changing project. Only meaningful
   * when a project is already committed (the user opened the picker from
   * the sidebar to switch). When absent, there is nothing to go back to.
   */
  onCancel?: () => void;
}

/**
 * The project picker — the first thing a user sees when no project is
 * committed, and reachable later via the sidebar's "Switch Project" button.
 *
 * Picking any entry calls `project:open`, which persists the choice and
 * relaunches the window into it. On success this screen stays in a
 * "Switching project…" state until the re-exec replaces it; there is no
 * in-place transition to handle.
 */
export function WelcomeScreen({ onCancel }: WelcomeScreenProps) {
  const invoke = useIpcInvoke();
  const [data, setData] = useState<ProjectListReply | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [switching, setSwitching] = useState(false);

  useEffect(() => {
    invoke<ProjectListReply>('project:list').then((reply) => {
      setData(
        reply ?? { current: null, recents: [], detected: null },
      );
    });
  }, [invoke]);

  const open = useCallback(
    async (projectPath: string) => {
      setError(null);
      setSwitching(true);
      const reply = await invoke<OpenReply>('project:open', projectPath);
      if (!reply?.ok) {
        setSwitching(false);
        setError(reply?.error ?? 'Could not open that project.');
      }
      // On success the main process relaunches the window; keep the
      // "Switching…" state until it does.
    },
    [invoke],
  );

  const openFolder = useCallback(async () => {
    setError(null);
    const reply = await invoke<OpenReply>('project:openDialog');
    if (reply?.canceled) return;
    if (!reply?.ok) {
      setError(reply?.error ?? 'Could not open that folder.');
      return;
    }
    if (reply.path) await open(reply.path);
  }, [invoke, open]);

  const current = data?.current ?? null;
  const recents = data?.recents ?? [];
  const detected = data?.detected ?? null;

  // Don't repeat the detected project if it's already the current one or
  // already in the recents list.
  const showDetected =
    detected !== null &&
    detected.path !== current?.path &&
    !recents.some((r) => r.path === detected.path);

  return (
    <div className="welcome-root">
      <div className="welcome-card">
        <div className="welcome-brand">
          <h1 className="welcome-title">rn-dev</h1>
          <p className="welcome-subtitle">
            Pick a React Native project to start
          </p>
        </div>

        <button
          className="welcome-open-btn"
          onClick={openFolder}
          disabled={switching}
        >
          <span className="welcome-open-icon" aria-hidden="true">
            &#128193;
          </span>
          <span>Open a folder…</span>
        </button>

        {error && (
          <div className="welcome-error" role="alert">
            {error}
          </div>
        )}

        {recents.length > 0 && (
          <div className="welcome-section">
            <div className="welcome-section-title">RECENT</div>
            <div className="welcome-list">
              {recents.map((r) => (
                <button
                  key={r.path}
                  className={`welcome-item${r.exists ? '' : ' missing'}`}
                  onClick={() => r.exists && open(r.path)}
                  disabled={switching || !r.exists}
                  title={r.path}
                >
                  <span className="welcome-item-name">{r.name}</span>
                  <span className="welcome-item-path">{r.path}</span>
                  {!r.exists && (
                    <span className="welcome-item-missing">missing</span>
                  )}
                </button>
              ))}
            </div>
          </div>
        )}

        {showDetected && detected && (
          <div className="welcome-detected">
            <span className="welcome-detected-label">
              Detected here: <strong>{detected.name}</strong>
            </span>
            <button
              className="welcome-detected-use"
              onClick={() => open(detected.path)}
              disabled={switching}
            >
              Use
            </button>
          </div>
        )}

        {(switching || onCancel) && (
          <div className="welcome-footer">
            {switching && (
              <span className="welcome-switching" role="status">
                Switching project…
              </span>
            )}
            {!switching && onCancel && current && (
              <button className="welcome-cancel" onClick={onCancel}>
                Cancel
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
