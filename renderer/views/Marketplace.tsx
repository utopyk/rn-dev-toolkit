import React, { useCallback, useEffect, useState } from 'react';
import { useIpcInvoke, useIpcOn } from '../hooks/useIpc';
import './Marketplace.css';

interface MarketplaceRow {
  id: string;
  version: string;
  scope: 'global' | 'per-worktree' | 'workspace';
  scopeUnit: string;
  state: string;
  isBuiltIn: boolean;
  kind: 'subprocess' | 'built-in-privileged';
  lastCrashReason: string | null;
  pid: number | null;
}

interface ListReply {
  modules: MarketplaceRow[];
}

export function Marketplace(): React.JSX.Element {
  const invoke = useIpcInvoke();
  const [rows, setRows] = useState<MarketplaceRow[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);

  const refresh = useCallback(() => {
    invoke('modules:list').then(
      (reply: ListReply | null) => {
        if (!reply) {
          setLoadError('IPC returned no response (module system may not be ready)');
          return;
        }
        setLoadError(null);
        setRows(reply.modules);
      },
      (err: unknown) => {
        setLoadError(err instanceof Error ? err.message : String(err));
      },
    );
  }, [invoke]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  // Re-fetch on any module-system event so install/uninstall/restart/
  // config-change ripple into the list without polling.
  useIpcOn('modules:event', refresh);

  if (loadError) {
    return (
      <div className="marketplace-view marketplace-view--error">
        <h2 className="marketplace-title">Marketplace</h2>
        <div className="marketplace-error-card">
          <p>Could not load the module list.</p>
          <p className="marketplace-error-detail">{loadError}</p>
        </div>
      </div>
    );
  }

  const sorted = [...rows].sort((a, b) => {
    // Built-ins first, then alphabetical by id.
    if (a.isBuiltIn !== b.isBuiltIn) return a.isBuiltIn ? -1 : 1;
    return a.id.localeCompare(b.id);
  });

  return (
    <div className="marketplace-view">
      <h2 className="marketplace-title">Marketplace</h2>
      <p className="marketplace-subtitle">
        {rows.length} module{rows.length === 1 ? '' : 's'} registered.
      </p>

      <table className="marketplace-table">
        <thead>
          <tr>
            <th>Module</th>
            <th>Version</th>
            <th>Kind</th>
            <th>Scope</th>
            <th>State</th>
          </tr>
        </thead>
        <tbody>
          {sorted.map((row) => (
            <tr key={`${row.id}:${row.scopeUnit}`} className="marketplace-row">
              <td>
                <span className="marketplace-module-id">{row.id}</span>
              </td>
              <td>
                <span className="marketplace-version">v{row.version}</span>
              </td>
              <td>
                <span
                  className={`marketplace-badge marketplace-badge--kind-${row.kind}`}
                >
                  {row.kind === 'built-in-privileged' ? 'built-in' : 'subprocess'}
                </span>
              </td>
              <td>
                <span className="marketplace-badge marketplace-badge--scope">
                  {row.scope}
                  {row.scope !== 'global' && row.scopeUnit !== 'global'
                    ? ` · ${row.scopeUnit}`
                    : ''}
                </span>
              </td>
              <td>
                <StateBadge state={row.state} pid={row.pid} />
                {row.lastCrashReason && (
                  <div className="marketplace-crash-reason">
                    ↳ {row.lastCrashReason}
                  </div>
                )}
              </td>
            </tr>
          ))}
          {sorted.length === 0 && (
            <tr>
              <td colSpan={5} className="marketplace-empty">
                No modules registered. Built-ins should always appear — if
                this row is empty, the host's module system hasn't
                finished booting.
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}

interface StateBadgeProps {
  state: string;
  pid: number | null;
}

function StateBadge({ state, pid }: StateBadgeProps): React.JSX.Element {
  const variant =
    state === 'active'
      ? 'active'
      : state === 'crashed' || state === 'failed'
      ? 'error'
      : state === 'inert' || state === 'idle'
      ? 'idle'
      : 'transient';
  return (
    <span className={`marketplace-badge marketplace-badge--state-${variant}`}>
      {state}
      {pid != null && pid > 0 ? ` (pid ${pid})` : ''}
    </span>
  );
}
