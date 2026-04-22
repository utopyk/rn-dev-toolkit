import React, { useCallback, useEffect, useState } from 'react';
import { useIpcInvoke, useIpcOn } from '../hooks/useIpc';
import { ConsentDialog, type ConsentRegistryEntry } from '../components/ConsentDialog';
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

// Mirrors src/app/modules-ipc.ts:MarketplaceEntryRow. Declared locally so
// the renderer doesn't reach across the src/renderer boundary (renderer
// tsconfig doesn't include src/); a parity test in __tests__ could keep
// these aligned if drift ever bites. For now the shapes are small enough
// to eyeball.
interface MarketplaceEntry extends ConsentRegistryEntry {
  installed: boolean;
  installedVersion?: string;
  installedState?: string;
}

interface MarketplaceListReply {
  kind: 'ok';
  registrySha256: string;
  registryUrl: string;
  entries: MarketplaceEntry[];
}

interface MarketplaceListError {
  kind: 'error';
  code: string;
  message: string;
}

interface InstallOkReply {
  kind: 'ok';
  moduleId: string;
  version: string;
  installPath: string;
  tarballSha256: string;
}

interface InstallErrorReply {
  kind: 'error';
  code: string;
  message: string;
}

type InstallReply = InstallOkReply | InstallErrorReply;

interface UninstallOkReply {
  kind: 'ok';
  moduleId: string;
  removed: string;
  keptData: boolean;
}

interface UninstallErrorReply {
  kind: 'error';
  code: string;
  message: string;
}

type UninstallReply = UninstallOkReply | UninstallErrorReply;

export function Marketplace(): React.JSX.Element {
  const invoke = useIpcInvoke();
  const [rows, setRows] = useState<MarketplaceRow[]>([]);
  const [availableEntries, setAvailableEntries] = useState<MarketplaceEntry[]>([]);
  const [registrySha256, setRegistrySha256] = useState<string>('');
  const [registryUrl, setRegistryUrl] = useState<string>('');
  const [loadError, setLoadError] = useState<string | null>(null);
  const [registryError, setRegistryError] = useState<string | null>(null);
  const [consentEntry, setConsentEntry] = useState<MarketplaceEntry | null>(null);
  const [pendingAction, setPendingAction] = useState<{ kind: 'install' | 'uninstall'; moduleId: string } | null>(null);
  const [actionResult, setActionResult] = useState<{ kind: 'ok' | 'error'; message: string } | null>(null);

  const refresh = useCallback(() => {
    invoke<ListReply | null>('modules:list').then(
      (reply) => {
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
    invoke<MarketplaceListReply | MarketplaceListError | null>(
      'marketplace:list',
    ).then(
      (reply) => {
        if (!reply) {
          setRegistryError('marketplace:list returned empty');
          return;
        }
        if (reply.kind === 'error') {
          setRegistryError(reply.message);
          return;
        }
        setRegistryError(null);
        setRegistrySha256(reply.registrySha256);
        setRegistryUrl(reply.registryUrl);
        setAvailableEntries(reply.entries);
      },
      (err: unknown) => {
        setRegistryError(err instanceof Error ? err.message : String(err));
      },
    );
  }, [invoke]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  // Re-fetch on any module-system event so install/uninstall/restart/
  // config-change ripple into the list without polling.
  useIpcOn('modules:event', refresh);

  const handleInstallClick = useCallback(
    async (entry: MarketplaceEntry) => {
      setConsentEntry(entry);
    },
    [],
  );

  const handleConfirmInstall = useCallback(
    async ({
      permissionsAccepted,
      thirdPartyAcknowledged,
    }: {
      permissionsAccepted: string[];
      thirdPartyAcknowledged: boolean;
    }) => {
      if (!consentEntry) return;
      const moduleId = consentEntry.id;
      setConsentEntry(null);
      setPendingAction({ kind: 'install', moduleId });
      setActionResult(null);
      const reply = await invoke<InstallReply>('modules:install', {
        moduleId,
        permissionsAccepted,
        thirdPartyAcknowledged,
      });
      setPendingAction(null);
      if (reply.kind === 'ok') {
        setActionResult({ kind: 'ok', message: `Installed ${moduleId} v${reply.version}` });
      } else {
        setActionResult({
          kind: 'error',
          message: `Install failed (${reply.code}): ${reply.message}`,
        });
      }
      refresh();
    },
    [consentEntry, invoke, refresh],
  );

  const handleUninstallClick = useCallback(
    async (row: MarketplaceRow) => {
      if (row.isBuiltIn) return;
      // eslint-disable-next-line no-alert
      if (!confirm(`Uninstall ${row.id}? This removes the module's files and stops its subprocess.`)) {
        return;
      }
      setPendingAction({ kind: 'uninstall', moduleId: row.id });
      setActionResult(null);
      const reply = await invoke<UninstallReply>('modules:uninstall', {
        moduleId: row.id,
      });
      setPendingAction(null);
      if (reply.kind === 'ok') {
        setActionResult({ kind: 'ok', message: `Uninstalled ${row.id}` });
      } else {
        setActionResult({
          kind: 'error',
          message: `Uninstall failed (${reply.code}): ${reply.message}`,
        });
      }
      refresh();
    },
    [invoke, refresh],
  );

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

  const notYetInstalled = availableEntries.filter((e) => !e.installed);

  return (
    <div className="marketplace-view">
      <h2 className="marketplace-title">Marketplace</h2>
      <p className="marketplace-subtitle">
        {rows.length} module{rows.length === 1 ? '' : 's'} registered
        {availableEntries.length > 0 && ` · ${availableEntries.length} in registry`}
      </p>

      {actionResult && (
        <div
          className={`marketplace-toast marketplace-toast--${actionResult.kind}`}
          role="status"
        >
          {actionResult.message}
          <button
            type="button"
            className="marketplace-toast-dismiss"
            onClick={() => setActionResult(null)}
          >
            ×
          </button>
        </div>
      )}

      <table className="marketplace-table">
        <thead>
          <tr>
            <th>Module</th>
            <th>Version</th>
            <th>Kind</th>
            <th>Scope</th>
            <th>State</th>
            <th>Action</th>
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
                <span className={`marketplace-badge marketplace-badge--kind-${row.kind}`}>
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
                  <div className="marketplace-crash-reason">↳ {row.lastCrashReason}</div>
                )}
              </td>
              <td>
                {row.isBuiltIn ? (
                  <span className="marketplace-action-note">system, uninstallable</span>
                ) : (
                  <button
                    type="button"
                    className="marketplace-action-btn marketplace-action-btn--uninstall"
                    disabled={pendingAction?.moduleId === row.id}
                    onClick={() => handleUninstallClick(row)}
                  >
                    {pendingAction?.moduleId === row.id && pendingAction.kind === 'uninstall'
                      ? 'Uninstalling…'
                      : 'Uninstall'}
                  </button>
                )}
              </td>
            </tr>
          ))}
          {sorted.length === 0 && (
            <tr>
              <td colSpan={6} className="marketplace-empty">
                No modules registered. Built-ins should always appear — if this row is empty, the
                host's module system hasn't finished booting.
              </td>
            </tr>
          )}
        </tbody>
      </table>

      <section className="marketplace-registry-section">
        <h3 className="marketplace-section-title">Available to install</h3>
        {registryError ? (
          <div className="marketplace-registry-error">
            <p>Could not reach the curated registry:</p>
            <p className="marketplace-error-detail">{registryError}</p>
          </div>
        ) : notYetInstalled.length === 0 ? (
          <p className="marketplace-empty-note">
            Every module listed in the curated registry is already installed.
          </p>
        ) : (
          <table className="marketplace-table">
            <thead>
              <tr>
                <th>Module</th>
                <th>Version</th>
                <th>Author</th>
                <th>Description</th>
                <th>Action</th>
              </tr>
            </thead>
            <tbody>
              {notYetInstalled.map((entry) => (
                <tr key={entry.id} className="marketplace-row">
                  <td>
                    <span className="marketplace-module-id">{entry.id}</span>
                  </td>
                  <td>
                    <span className="marketplace-version">v{entry.version}</span>
                  </td>
                  <td>{entry.author}</td>
                  <td className="marketplace-description-cell">{entry.description}</td>
                  <td>
                    <button
                      type="button"
                      className="marketplace-action-btn marketplace-action-btn--install"
                      disabled={pendingAction?.moduleId === entry.id}
                      onClick={() => handleInstallClick(entry)}
                    >
                      {pendingAction?.moduleId === entry.id && pendingAction.kind === 'install'
                        ? 'Installing…'
                        : 'Install'}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      {consentEntry && (
        <ConsentDialog
          entry={consentEntry}
          registryUrl={registryUrl}
          registrySha256={registrySha256}
          onCancel={() => setConsentEntry(null)}
          onConfirm={handleConfirmInstall}
        />
      )}
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
