import React from 'react';
import './StatusBar.css';

interface StatusBarProps {
  metroStatus: 'running' | 'starting' | 'stopped' | 'error';
  metroPort: number;
  watcherOn: boolean;
  activeTab: string;
}

const tabLabels: Record<string, string> = {
  'dev-space': 'Dev Space',
  'devtools': 'DevTools',
  'lint-test': 'Lint & Test',
  'metro-logs': 'Metro Logs',
  'settings': 'Settings',
};

function labelFor(activeTab: string): string {
  if (tabLabels[activeTab]) return tabLabels[activeTab];
  if (activeTab.startsWith('module:')) {
    const rest = activeTab.slice('module:'.length);
    const colon = rest.indexOf(':');
    if (colon > 0) return rest.slice(colon + 1);
  }
  return activeTab;
}

export function StatusBar({ metroStatus, metroPort, watcherOn, activeTab }: StatusBarProps) {
  return (
    <div className="bottom-bar">
      <div className="shortcuts-bar">
        <span><span className="key">[r]</span> Reload</span>
        <span><span className="key">[d]</span> DevMenu</span>
        <span><span className="key">[l]</span> Lint</span>
        <span><span className="key">[t]</span> TypeChk</span>
        <span><span className="key">[c]</span> Clean</span>
        <span><span className="key">[f]</span> Focus</span>
        <span><span className="key">[q]</span> Quit</span>
      </div>
      <div className="status-right">
        <span>
          Metro: <span className={`status-dot ${metroStatus}`} />
          {metroStatus === 'running' ? `Running :${metroPort}` : metroStatus}
        </span>
        <span className="sep">|</span>
        <span>
          Watcher:{' '}
          <span style={{ color: watcherOn ? 'var(--success)' : 'var(--muted)', fontWeight: 'bold' }}>
            {watcherOn ? 'ON' : 'OFF'}
          </span>
        </span>
        <span className="sep">|</span>
        <span>
          Module: <span style={{ color: 'var(--accent)' }}>{labelFor(activeTab)}</span>
        </span>
      </div>
    </div>
  );
}
