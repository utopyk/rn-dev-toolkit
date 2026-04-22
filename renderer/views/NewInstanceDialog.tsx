import React, { useState, useEffect } from 'react';
import { useIpcInvoke } from '../hooks/useIpc';
import './NewInstanceDialog.css';

interface ProfileSummary {
  name: string;
  branch: string;
  platform: string;
  mode: string;
  isDefault: boolean;
  deviceId: string | null;
}

interface NewInstanceDialogProps {
  onSelectProfile: (profileName: string) => void;
  onCreateNew: () => void;
  onCancel: () => void;
}

export function NewInstanceDialog({ onSelectProfile, onCreateNew, onCancel }: NewInstanceDialogProps) {
  const [profiles, setProfiles] = useState<ProfileSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const invoke = useIpcInvoke();

  useEffect(() => {
    setLoading(true);
    invoke<ProfileSummary[]>('profiles:list').then((data) => {
      setProfiles(data ?? []);
      setLoading(false);
    });
  }, [invoke]);

  const handleDelete = async (e: React.MouseEvent, name: string) => {
    e.stopPropagation();
    await invoke('profiles:delete', name);
    setProfiles(prev => prev.filter(p => p.name !== name));
  };

  const handleSetDefault = async (e: React.MouseEvent, name: string) => {
    e.stopPropagation();
    await invoke('profiles:setDefault', name);
    setProfiles(prev =>
      prev.map(p => ({ ...p, isDefault: p.name === name }))
    );
  };

  // Sort: default profile first, then alphabetical
  const sorted = [...profiles].sort((a, b) => {
    if (a.isDefault && !b.isDefault) return -1;
    if (!a.isDefault && b.isDefault) return 1;
    return a.name.localeCompare(b.name);
  });

  return (
    <div className="nid-root">
      <div className="nid-container">
        <div className="nid-header">
          <div>
            <h1 className="nid-title">New Instance</h1>
            <p className="nid-subtitle">Choose a profile to start from:</p>
          </div>
        </div>

        {loading ? (
          <div className="nid-loading">Loading profiles...</div>
        ) : (
          <>
            {sorted.length > 0 && (
              <div className="nid-list">
                {sorted.map(profile => (
                  <div
                    key={profile.name}
                    className={`nid-profile-card${profile.isDefault ? ' is-default' : ''}`}
                    onClick={() => onSelectProfile(profile.name)}
                  >
                    <span className="nid-profile-star">
                      {profile.isDefault ? '\u2B50' : ''}
                    </span>
                    <div className="nid-profile-info">
                      <span className="nid-profile-name">
                        {profile.name}
                        {profile.isDefault ? ' (default)' : ''}
                      </span>
                      <span className="nid-profile-meta">
                        <span>{profile.branch}</span>
                        <span className="nid-profile-meta-sep">&middot;</span>
                        <span>{profile.platform}</span>
                        <span className="nid-profile-meta-sep">&middot;</span>
                        <span>{profile.mode}</span>
                      </span>
                    </div>
                    <div className="nid-profile-actions">
                      {!profile.isDefault && (
                        <button
                          className="nid-profile-action-btn"
                          onClick={(e) => handleSetDefault(e, profile.name)}
                          title="Set as default"
                        >
                          &#9734;
                        </button>
                      )}
                      <button
                        className="nid-profile-action-btn danger"
                        onClick={(e) => handleDelete(e, profile.name)}
                        title="Delete profile"
                      >
                        &#x1D5EB;
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}

            <button className="nid-create-card" onClick={onCreateNew}>
              <span className="nid-create-icon">+</span>
              <span>Create new profile...</span>
            </button>
          </>
        )}

        <div className="nid-footer">
          <button className="wz-btn wz-btn-ghost" onClick={onCancel}>
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}
