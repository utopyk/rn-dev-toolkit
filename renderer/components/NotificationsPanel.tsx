import React from 'react';
import { ModuleIcon } from './icons.js';
import './NotificationsPanel.css';

interface NotificationsPanelProps {
  expanded: boolean;
  onToggle: () => void;
}

export function NotificationsPanel({ expanded, onToggle }: NotificationsPanelProps) {
  return (
    <aside className={`notifications-panel${expanded ? ' expanded' : ''}`}>
      <div className="notifications-top">
        <button
          className="notifications-toggle"
          onClick={onToggle}
          aria-label={expanded ? 'Collapse notifications' : 'Expand notifications'}
        >
          <ModuleIcon hint={expanded ? 'chevronRight' : 'bell'} size={16} />
        </button>
      </div>
      {expanded ? (
        <>
          <div className="notifications-header">
            <h2 className="notifications-title">Activity</h2>
            <span className="notifications-subtitle">Agent tool calls</span>
          </div>
          <div className="notifications-empty">
            <ModuleIcon hint="bell" size={24} />
            <p>No activity yet</p>
            <span>Tool calls from MCP clients will appear here.</span>
          </div>
        </>
      ) : (
        <div className="notifications-collapsed-indicator">
          <ModuleIcon hint="bell" size={18} />
        </div>
      )}
    </aside>
  );
}
