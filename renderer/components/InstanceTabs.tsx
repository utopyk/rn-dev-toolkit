import React from 'react';
import './InstanceTabs.css';

export interface InstanceInfo {
  id: string;
  worktreeName: string;
  branch: string;
  port: number;
  deviceName: string;
  deviceIcon: string;
  platform: string;
  metroStatus: string;
}

interface InstanceTabsProps {
  instances: InstanceInfo[];
  activeId: string | null;
  onSelect: (id: string) => void;
  onClose: (id: string) => void;
  onAdd: () => void;  // Opens the new-instance dialog
}

function shortenName(name: string, max: number): string {
  if (name.length <= max) return name;
  return name.slice(0, max - 1) + '…';
}

function statusDotClass(status: string): string {
  switch (status) {
    case 'running': return 'instance-dot running';
    case 'starting': return 'instance-dot starting';
    case 'error': return 'instance-dot error';
    default: return 'instance-dot stopped';
  }
}

export function InstanceTabs({ instances, activeId, onSelect, onClose, onAdd }: InstanceTabsProps) {
  // Single click fires onClose immediately. The "are you sure" gate
  // lives at the parent (App.tsx) as a real modal — pre-2026-05-07 a
  // two-click confirm with a pulsing red glyph lived inline in this
  // component, but a series of user reports surfaced the affordance
  // as confusing ("all it does is change an icon to red") and
  // unusual ("if we want to make sure the user wants to kill the
  // tab, we should pop up a modal not a second click"). The modal is
  // the standard pattern; this component is back to a stateless tab
  // strip.
  const handleClose = (e: React.MouseEvent, id: string) => {
    e.stopPropagation();
    onClose(id);
  };

  return (
    <div className="instance-tabs">
      <div className="instance-tabs-scroll">
        {instances.map((inst) => {
          const isActive = inst.id === activeId;
          return (
            <div
              key={inst.id}
              className={`instance-tab${isActive ? ' active' : ''}`}
              onClick={() => onSelect(inst.id)}
            >
              <span className="instance-tab-icon">{inst.deviceIcon}</span>
              <span className="instance-tab-name">
                {shortenName(inst.worktreeName, 10)}:{inst.port}
              </span>
              <span className="instance-tab-device">
                {shortenName(inst.deviceName, 14)}
              </span>
              <span className={statusDotClass(inst.metroStatus)} />
              <button
                className="instance-tab-close"
                onClick={(e) => handleClose(e, inst.id)}
                aria-label={`Close instance on port ${inst.port}`}
                title="Close instance"
              >
                {'×'}
              </button>
            </div>
          );
        })}
        <button className="instance-tab-add" onClick={onAdd} title="New instance">
          +
        </button>
      </div>
    </div>
  );
}
