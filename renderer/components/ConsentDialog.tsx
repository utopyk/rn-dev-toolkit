import React, { useEffect, useState } from 'react';
import { useIpcInvoke } from '../hooks/useIpc';
import './ConsentDialog.css';

const PERMISSION_LABELS: Record<string, string> = {
  'exec:adb': 'Run Android Debug Bridge (adb) commands on connected devices.',
  'exec:simctl': 'Run iOS simulator control commands (xcrun simctl).',
  'exec:idb': 'Run iOS Development Bridge (idb) against booted simulators.',
  'fs:artifacts': "Read and write your project's .rn-dev/artifacts directory.",
  'network:outbound': 'Make outbound network requests to arbitrary hosts.',
};

export interface ConsentRegistryEntry {
  id: string;
  npmPackage: string;
  version: string;
  tarballSha256: string;
  description: string;
  author: string;
  permissions: string[];
  homepage?: string;
}

interface ConsentDialogProps {
  entry: ConsentRegistryEntry;
  /** URL the caller fetched the registry from (shown for user audit). */
  registryUrl: string;
  /** SHA-256 of the fetched `modules.json` blob. */
  registrySha256: string;
  onCancel: () => void;
  /**
   * Called when the user confirms. `permissionsAccepted` is always the full
   * declared set — the dialog doesn't let users cherry-pick a subset since
   * the module will fail at runtime without them.
   */
  onConfirm: (args: { permissionsAccepted: string[]; thirdPartyAcknowledged: boolean }) => void;
}

export function ConsentDialog({
  entry,
  registryUrl,
  registrySha256,
  onCancel,
  onConfirm,
}: ConsentDialogProps): React.JSX.Element {
  const invoke = useIpcInvoke();
  const [trustToggle, setTrustToggle] = useState(false);
  const [freshHostAck, setFreshHostAck] = useState(false);
  const [needsFreshHostAck, setNeedsFreshHostAck] = useState<boolean | null>(null);

  useEffect(() => {
    invoke<{ acknowledged: boolean }>('modules:has-third-party-ack').then(
      (reply) => {
        setNeedsFreshHostAck(!reply?.acknowledged);
      },
      () => setNeedsFreshHostAck(true),
    );
  }, [invoke]);

  const readyToInstall =
    trustToggle && (needsFreshHostAck === false || freshHostAck);

  const handleInstall = (): void => {
    if (!readyToInstall) return;
    // Ack persistence happens main-side; GUI still passes the flag through
    // so the installer's fresh-host gate clears on the first click.
    if (needsFreshHostAck && freshHostAck) {
      void invoke('modules:acknowledge-third-party');
    }
    onConfirm({
      permissionsAccepted: [...entry.permissions],
      thirdPartyAcknowledged: true,
    });
  };

  return (
    <div className="consent-backdrop" role="dialog" aria-modal="true">
      <div className="consent-dialog">
        <header className="consent-header">
          <h2 className="consent-title">Install {entry.id}?</h2>
          <p className="consent-subtitle">
            v{entry.version} — {entry.author}
          </p>
        </header>

        <section className="consent-body">
          <p className="consent-description">{entry.description}</p>

          <div className="consent-section">
            <h3>Source</h3>
            <dl className="consent-kv">
              <dt>npm package</dt>
              <dd>
                <code>{entry.npmPackage}@{entry.version}</code>
              </dd>
              <dt>Tarball SHA-256</dt>
              <dd><code className="consent-sha">{entry.tarballSha256}</code></dd>
              <dt>Registry</dt>
              <dd><code className="consent-sha">{registryUrl}</code></dd>
              <dt>Registry SHA-256</dt>
              <dd><code className="consent-sha">{registrySha256}</code></dd>
              {entry.homepage && (
                <>
                  <dt>Homepage</dt>
                  <dd><code>{entry.homepage}</code></dd>
                </>
              )}
            </dl>
          </div>

          <div className="consent-section">
            <h3>Permissions the module declares</h3>
            {entry.permissions.length === 0 ? (
              <p className="consent-empty">No special permissions declared.</p>
            ) : (
              <ul className="consent-permission-list">
                {entry.permissions.map((p) => (
                  <li key={p}>
                    <code>{p}</code>
                    {PERMISSION_LABELS[p] && (
                      <span className="consent-permission-desc"> — {PERMISSION_LABELS[p]}</span>
                    )}
                  </li>
                ))}
              </ul>
            )}
            <p className="consent-advisory">
              These permissions are advisory in this host release — they're
              shown so you know what the module is asking for. Subprocess
              isolation + the curated registry + this consent dialog are the
              v1 safety story; runtime enforcement lands in a later release.
            </p>
          </div>

          {needsFreshHostAck && (
            <div className="consent-section consent-first-install">
              <h3>First third-party module</h3>
              <p>
                This is the first third-party module you're installing. Before
                proceeding, please acknowledge:
              </p>
              <label className="consent-checkbox">
                <input
                  type="checkbox"
                  checked={freshHostAck}
                  onChange={(e) => setFreshHostAck(e.target.checked)}
                />
                I understand third-party modules run as my user account and
                can do anything I can — read and modify files, make network
                requests, run shell commands. I will only install modules
                from authors I trust.
              </label>
            </div>
          )}

          <label className="consent-checkbox">
            <input
              type="checkbox"
              checked={trustToggle}
              onChange={(e) => setTrustToggle(e.target.checked)}
            />
            I trust <strong>{entry.author}</strong> to write and maintain this
            module responsibly.
          </label>
        </section>

        <footer className="consent-footer">
          <button type="button" className="consent-button" onClick={onCancel}>
            Cancel
          </button>
          <button
            type="button"
            className="consent-button consent-button--primary"
            disabled={!readyToInstall}
            onClick={handleInstall}
          >
            Install
          </button>
        </footer>
      </div>
    </div>
  );
}
