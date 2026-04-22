import React from 'react';
import './Sidebar.css';

interface ModuleItem {
  id: string;
  icon: string;
  label: string;
}

interface ShortcutItem {
  key: string;
  label: string;
  command: string | null;
}

const builtinModules: ModuleItem[] = [
  { id: 'dev-space', icon: '🚀', label: 'Dev Space' },
  { id: 'devtools', icon: '🔧', label: 'DevTools' },
  { id: 'lint-test', icon: '🧪', label: 'Lint & Test' },
  { id: 'metro-logs', icon: '📡', label: 'Metro Logs' },
  { id: 'marketplace', icon: '🛒', label: 'Marketplace' },
  { id: 'settings', icon: '⚙', label: 'Settings' },
];

const shortcuts: ShortcutItem[] = [
  { key: 'r', label: 'Reload', command: 'metro:reload' },
  { key: 'd', label: 'Dev Menu', command: 'metro:devMenu' },
  { key: 'l', label: 'Lint', command: 'run:lint' },
  { key: 't', label: 'Type Check', command: 'run:typecheck' },
  { key: 'c', label: 'Clean', command: 'run:clean' },
  { key: 'w', label: 'Watcher', command: 'watcher:toggle' },
  { key: 'o', label: 'Dump Logs', command: 'logs:dump' },
];

export interface SidebarModulePanel {
  /** `module:<moduleId>:<panelId>` */
  id: string;
  title: string;
  icon?: string;
}

interface SidebarProps {
  activeTab: string;
  onTabChange: (tab: string) => void;
  onShortcut: (command: string) => void;
  onOpenWizard?: () => void;
  modulePanels?: SidebarModulePanel[];
}

export function Sidebar({
  activeTab,
  onTabChange,
  onShortcut,
  onOpenWizard,
  modulePanels = [],
}: SidebarProps) {
  return (
    <div className="sidebar">
      {/* Logo */}
      <div className="sidebar-logo">
        <div className="logo-l1">╦═╗╔╗╗  ╦═╗╔═╗╦  ╦</div>
        <div className="logo-l2">╠╦╝║║║  ║ ║╠═  ║║</div>
        <div className="logo-l3">╩╚═╝╚╝  ╩═╝╚═╝ ╚╝</div>
      </div>

      {/* Modules */}
      <div className="sidebar-section">
        <div className="sidebar-section-title">MODULES</div>
        {builtinModules.map((mod) => (
          <button
            key={mod.id}
            className={`sidebar-item sidebar-module${activeTab === mod.id ? ' active' : ''}`}
            onClick={() => onTabChange(mod.id)}
          >
            <span className="sidebar-module-icon">{mod.icon}</span>
            <span className="sidebar-item-label">{mod.label}</span>
          </button>
        ))}
      </div>

      {modulePanels.length > 0 && (
        <div className="sidebar-section">
          <div className="sidebar-section-title">EXTENSIONS</div>
          {modulePanels.map((panel) => (
            <button
              key={panel.id}
              className={`sidebar-item sidebar-module${activeTab === panel.id ? ' active' : ''}`}
              onClick={() => onTabChange(panel.id)}
            >
              <span className="sidebar-module-icon">{panel.icon ?? '📦'}</span>
              <span className="sidebar-item-label">{panel.title}</span>
            </button>
          ))}
        </div>
      )}

      {/* Shortcuts */}
      <div className="sidebar-section sidebar-shortcuts">
        <div className="sidebar-section-title">SHORTCUTS</div>
        {shortcuts.map((s) => (
          <button
            key={s.key}
            className="sidebar-shortcut"
            onClick={() => s.command && onShortcut(s.command)}
          >
            <span className="shortcut-key">[{s.key}]</span>
            <span className="shortcut-label">{s.label}</span>
          </button>
        ))}
      </div>

      {/* Footer */}
      <div className="sidebar-footer">
        {onOpenWizard && (
          <button className="sidebar-new-worktree" onClick={onOpenWizard}>
            Setup Wizard
          </button>
        )}
      </div>
    </div>
  );
}
