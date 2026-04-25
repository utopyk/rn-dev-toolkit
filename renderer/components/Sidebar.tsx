import React from 'react';
import './Sidebar.css';
import { ModuleIcon } from './icons.js';

interface ModuleItem {
  id: string;
  hint: string;
  label: string;
}

interface ShortcutItem {
  key: string;
  label: string;
  command: string | null;
}

const builtinModules: ModuleItem[] = [
  { id: 'dev-space',   hint: 'terminal', label: 'Dev Space' },
  { id: 'devtools',    hint: 'wrench',   label: 'DevTools' },
  { id: 'lint-test',   hint: 'flask',    label: 'Lint & Test' },
  { id: 'metro-logs',  hint: 'radio',    label: 'Metro Logs' },
  { id: 'marketplace', hint: 'store',    label: 'Marketplace' },
  { id: 'settings',    hint: 'settings', label: 'Settings' },
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
  collapsed: boolean;
  onToggleCollapse: () => void;
}

export function Sidebar({
  activeTab,
  onTabChange,
  onShortcut,
  onOpenWizard,
  modulePanels = [],
  collapsed,
  onToggleCollapse,
}: SidebarProps) {
  return (
    <div className={`sidebar${collapsed ? ' collapsed' : ''}`}>
      <div className="sidebar-top">
        <button
          className="sidebar-collapse-toggle"
          onClick={onToggleCollapse}
          aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
        >
          <ModuleIcon hint={collapsed ? 'chevronRight' : 'chevronLeft'} size={14} />
        </button>
      </div>
      {!collapsed && (
        <div className="sidebar-brand">
          <h1 className="sidebar-brand-name">RN Dev</h1>
          <span className="sidebar-brand-sub">Developer Suite</span>
        </div>
      )}

      {/* Modules */}
      <div className="sidebar-section">
        <div className="sidebar-section-title">MODULES</div>
        {builtinModules.map((mod) => (
          <button
            key={mod.id}
            className={`sidebar-item sidebar-module${activeTab === mod.id ? ' active' : ''}`}
            aria-label={mod.label}
            onClick={() => onTabChange(mod.id)}
          >
            <span className="sidebar-module-icon"><ModuleIcon hint={mod.hint} size={18} /></span>
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
              aria-label={panel.title}
              onClick={() => onTabChange(panel.id)}
            >
              <span className="sidebar-module-icon"><ModuleIcon hint={panel.icon} size={18} /></span>
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
