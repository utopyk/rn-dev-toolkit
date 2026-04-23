import React, { useEffect, useRef } from 'react';
import './UninstallConfirmDialog.css';

export interface UninstallConfirmDialogProps {
  moduleId: string;
  /** If true, the "Uninstall" button is rendered in pending state. */
  pending?: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}

/**
 * Styled uninstall confirmation dialog replacing `window.confirm`.
 * Mirrors ConsentDialog's visual style so the install/uninstall surfaces
 * feel like the same feature instead of an OS-native popup that breaks
 * the Marketplace polish.
 */
export function UninstallConfirmDialog({
  moduleId,
  pending,
  onCancel,
  onConfirm,
}: UninstallConfirmDialogProps): React.JSX.Element {
  const cancelButtonRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    // Focus Cancel first — destructive default should never be Enter.
    cancelButtonRef.current?.focus();
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onCancel();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onCancel]);

  return (
    <div className="uninstall-backdrop" role="dialog" aria-modal="true">
      <div className="uninstall-dialog">
        <header className="uninstall-header">
          <h2 className="uninstall-title">Uninstall {moduleId}?</h2>
          <p className="uninstall-subtitle">
            This removes the module's files and stops its subprocess.
          </p>
        </header>

        <div className="uninstall-body">
          <ul className="uninstall-details">
            <li>
              <span className="uninstall-detail-label">Files:</span>{' '}
              <code>~/.rn-dev/modules/{moduleId}/</code> will be deleted.
            </li>
            <li>
              <span className="uninstall-detail-label">Subprocess:</span>{' '}
              Active instances get a SIGTERM and are removed from the registry.
            </li>
            <li>
              <span className="uninstall-detail-label">Config:</span>{' '}
              Persisted <code>config.json</code> is removed along with the module.
            </li>
          </ul>
          <p className="uninstall-note">
            To reinstall, walk the Marketplace install flow again — SHA-pinned
            registry + consent dialog run the same checks as a first install.
          </p>
        </div>

        <footer className="uninstall-footer">
          <button
            ref={cancelButtonRef}
            type="button"
            className="uninstall-button uninstall-button--cancel"
            onClick={onCancel}
            disabled={pending}
          >
            Cancel
          </button>
          <button
            type="button"
            className="uninstall-button uninstall-button--destructive"
            onClick={onConfirm}
            disabled={pending}
          >
            {pending ? 'Uninstalling…' : 'Uninstall'}
          </button>
        </footer>
      </div>
    </div>
  );
}
