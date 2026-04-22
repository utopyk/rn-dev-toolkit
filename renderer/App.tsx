import React, { useState, useCallback, useEffect, useRef } from 'react';
import type { ProfileInfo, InstanceInfo, InstanceLogs, LogSection, SectionStartEvent, SectionEndEvent } from './types';
import { Sidebar } from './components/Sidebar';
import type { SidebarModulePanel } from './components/Sidebar';
import { StatusBar } from './components/StatusBar';
import { ProfileBanner } from './components/ProfileBanner';
import { InstanceTabs } from './components/InstanceTabs';
import { ModulePanel } from './components/ModulePanel';
import { DevSpace } from './views/DevSpace';
import { DevToolsView } from './views/DevToolsView';
import { LintTest } from './views/LintTest';
import { Marketplace } from './views/Marketplace';
import { MetroLogs } from './views/MetroLogs';
import { Settings } from './views/Settings';
import { Wizard } from './views/Wizard';
import { NewInstanceDialog } from './views/NewInstanceDialog';
import { useIpcOn, useIpcInvoke } from './hooks/useIpc';
import { useSimulatedLogs } from './hooks/useSimulatedLogs';
import type { SimulatedSectionEvent } from './hooks/useSimulatedLogs';
import './App.css';

interface ModulePanelListEntry {
  moduleId: string;
  panelId: string;
  title: string;
  icon?: string;
}

function makeEmptyLogs(): InstanceLogs {
  return { serviceLines: [], metroLines: [], sections: [] };
}

export function App() {
  const [activeTab, setActiveTab] = useState<string>('dev-space');
  const [modulePanels, setModulePanels] = useState<ModulePanelListEntry[]>([]);
  const [profileVisible, setProfileVisible] = useState(true);
  const [showWizard, setShowWizard] = useState(false);
  const [showNewInstanceDialog, setShowNewInstanceDialog] = useState(false);
  const [promptModal, setPromptModal] = useState<{
    promptId: string;
    title: string;
    message: string;
    options: Array<{ value: string; label: string; cleanup?: string }>;
  } | null>(null);

  // Multi-instance state
  const [instances, setInstances] = useState<InstanceInfo[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const instanceLogsRef = useRef<Map<string, InstanceLogs>>(new Map());
  const [logVersion, setLogVersion] = useState(0); // trigger re-renders for logs

  const invoke = useIpcInvoke();

  // On mount + on every module-system event: refetch the panel list so
  // 3p extensions appear in the sidebar without a reload. Reuses the
  // same subscribe stream MCP's `tools/listChanged` consumes.
  const fetchPanels = useCallback(() => {
    invoke('modules:list-panels').then((resp: {
      modules: Array<{
        moduleId: string;
        panels: Array<{ id: string; title: string; icon?: string }>;
      }>;
    } | null) => {
      const next: ModulePanelListEntry[] = [];
      for (const m of resp?.modules ?? []) {
        for (const p of m.panels) {
          next.push({
            moduleId: m.moduleId,
            panelId: p.id,
            title: p.title,
            icon: p.icon,
          });
        }
      }
      setModulePanels(next);
    });
  }, [invoke]);

  useEffect(() => {
    fetchPanels();
  }, [fetchPanels]);

  useIpcOn('modules:event', useCallback(() => {
    fetchPanels();
  }, [fetchPanels]));

  // On mount: fetch existing instances; if none exist and no profile, show wizard
  useEffect(() => {
    invoke('instances:list').then((list: InstanceInfo[]) => {
      if (list && list.length > 0) {
        setInstances(list);
        setActiveId(list[0].id);
        // Fetch logs for all instances
        for (const inst of list) {
          invoke('instances:getLogs', inst.id).then((logs: { serviceLines: string[]; metroLines: string[] }) => {
            instanceLogsRef.current.set(inst.id, {
              serviceLines: logs?.serviceLines ?? [],
              metroLines: logs?.metroLines ?? [],
            });
            setLogVersion(v => v + 1);
          });
        }
      } else {
        // No instances yet — check if any profiles exist
        invoke('profiles:list').then((profiles: any[]) => {
          if (!profiles || profiles.length === 0) {
            // No profiles at all — go straight to wizard
            setShowWizard(true);
          }
          // If profiles exist, startRealServices in main will create one
          // from the default profile, and we'll get it via instance:created event
        });
      }
    });
  }, [invoke]);

  // Helper to append a line to an instance's log buffer
  const appendInstanceLog = useCallback((instanceId: string, type: 'service' | 'metro', text: string) => {
    const logs = instanceLogsRef.current.get(instanceId) ?? makeEmptyLogs();
    const arr = type === 'service' ? logs.serviceLines : logs.metroLines;
    arr.push(text);
    if (arr.length > 1000) arr.splice(0, arr.length - 1000);

    // Also route service lines into the currently-running section
    if (type === 'service' && logs.sections.length > 0) {
      const activeSection = logs.sections.find(s => s.status === 'running');
      if (activeSection) {
        activeSection.lines.push(text);
      }
    }

    instanceLogsRef.current.set(instanceId, logs);
    setLogVersion(v => v + 1);
  }, []);

  // IPC listeners for instance events
  useIpcOn('instance:created', useCallback((info: InstanceInfo) => {
    setInstances(prev => {
      if (prev.find(i => i.id === info.id)) return prev;
      return [...prev, info];
    });
    instanceLogsRef.current.set(info.id, makeEmptyLogs());
    setActiveId(info.id);
  }, []));

  useIpcOn('instance:removed', useCallback((instanceId: string) => {
    setInstances(prev => prev.filter(i => i.id !== instanceId));
    instanceLogsRef.current.delete(instanceId);
    setActiveId(prev => {
      if (prev === instanceId) {
        const remaining = Array.from(instanceLogsRef.current.keys());
        return remaining.length > 0 ? remaining[0] : null;
      }
      return prev;
    });
  }, []));

  useIpcOn('instance:log', useCallback((data: { instanceId: string; text: string }) => {
    appendInstanceLog(data.instanceId, 'service', data.text);
  }, [appendInstanceLog]));

  useIpcOn('instance:metro', useCallback((data: { instanceId: string; text: string }) => {
    appendInstanceLog(data.instanceId, 'metro', data.text);
  }, [appendInstanceLog]));

  useIpcOn('instance:status', useCallback((data: InstanceInfo & { instanceId: string }) => {
    setInstances(prev => prev.map(i =>
      i.id === data.instanceId
        ? { ...i, metroStatus: data.metroStatus, deviceName: data.deviceName, deviceIcon: data.deviceIcon }
        : i
    ));
  }, []));

  useIpcOn('instance:build:line', useCallback((data: { instanceId: string; text: string }) => {
    appendInstanceLog(data.instanceId, 'service', data.text);
  }, [appendInstanceLog]));

  useIpcOn('instance:build:done', useCallback((data: { instanceId: string; success: boolean }) => {
    // Build done is informational; logs are already appended via instance:log
  }, []));

  // Handle prompts from main process (e.g., package manager selection)
  useIpcOn('instance:prompt', useCallback((data: {
    instanceId: string;
    promptId: string;
    title: string;
    message: string;
    options: Array<{ value: string; label: string; cleanup?: string }>;
  }) => {
    setPromptModal({
      promptId: data.promptId,
      title: data.title,
      message: data.message,
      options: data.options,
    });
  }, []));

  // Section start/end IPC events
  useIpcOn('instance:section:start', useCallback((data: SectionStartEvent) => {
    const logs = instanceLogsRef.current.get(data.instanceId);
    if (!logs) return;
    // Don't add duplicate sections
    if (logs.sections.find(s => s.id === data.id)) return;
    logs.sections.push({
      id: data.id,
      title: data.title,
      icon: data.icon,
      lines: [],
      status: 'running',
      collapsed: false,
    });
    setLogVersion(v => v + 1);
  }, []));

  useIpcOn('instance:section:end', useCallback((data: SectionEndEvent) => {
    const logs = instanceLogsRef.current.get(data.instanceId);
    if (!logs) return;
    const section = logs.sections.find(s => s.id === data.id);
    if (!section) return;
    section.status = data.status;
    // Auto-collapse completed sections (not errors — keep errors visible)
    if (data.status === 'ok' || data.status === 'warning') {
      section.collapsed = true;
    }
    setLogVersion(v => v + 1);
  }, []));

  // Legacy IPC listeners (for backward compat / browser-only mode)
  const addServiceLogLegacy = useCallback((line: string) => {
    if (activeId) {
      appendInstanceLog(activeId, 'service', line);
    }
  }, [activeId, appendInstanceLog]);

  const addMetroLogLegacy = useCallback((line: string) => {
    if (activeId) {
      appendInstanceLog(activeId, 'metro', line);
    }
  }, [activeId, appendInstanceLog]);

  useIpcOn('service:log', addServiceLogLegacy);
  useIpcOn('metro:log', addMetroLogLegacy);
  useIpcOn('build:line', addServiceLogLegacy);

  // Section toggle handler
  const handleToggleSection = useCallback((instanceId: string, sectionId: string) => {
    const logs = instanceLogsRef.current.get(instanceId);
    if (!logs) return;
    const section = logs.sections.find(s => s.id === sectionId);
    if (section) {
      section.collapsed = !section.collapsed;
      setLogVersion(v => v + 1);
    }
  }, []);

  // Section retry handler
  const handleRetrySection = useCallback((instanceId: string, sectionId: string) => {
    // Reset section to running state in local log state
    const logs = instanceLogsRef.current.get(instanceId);
    if (logs) {
      const section = logs.sections.find(s => s.id === sectionId);
      if (section) {
        section.status = 'running';
        section.lines = [];
        section.collapsed = false;
        setLogVersion(v => v + 1);
      }
    }
    invoke('instance:retryStep', { instanceId, stepId: sectionId });
  }, [invoke]);

  // Helper to handle section events from simulated logs
  const handleSimulatedSectionEvent = useCallback((event: SimulatedSectionEvent) => {
    const logs = instanceLogsRef.current.get('main-8081');
    if (!logs) return;
    if (event.type === 'section:start') {
      if (logs.sections.find(s => s.id === event.id)) return;
      logs.sections.push({
        id: event.id,
        title: event.title ?? event.id,
        icon: event.icon ?? '\u23F3',
        lines: [],
        status: 'running',
        collapsed: false,
      });
    } else if (event.type === 'section:end') {
      const section = logs.sections.find(s => s.id === event.id);
      if (section) {
        section.status = event.status ?? 'ok';
        if (event.status === 'ok' || event.status === 'warning') {
          section.collapsed = true;
        }
      }
    }
    setLogVersion(v => v + 1);
  }, []);

  // Simulated logs (browser-only mode)
  useSimulatedLogs(
    useCallback((line: string) => {
      // In browser mode, create a fake instance if none exist
      if (instances.length === 0) {
        const fakeInst: InstanceInfo = {
          id: 'main-8081',
          worktreeName: 'main',
          branch: 'main',
          port: 8081,
          deviceName: 'iPhone 16 Pro',
          deviceIcon: '\uD83D\uDCBB',
          platform: 'ios',
          metroStatus: 'running',
        };
        setInstances([fakeInst]);
        setActiveId('main-8081');
        instanceLogsRef.current.set('main-8081', makeEmptyLogs());
      }
      appendInstanceLog('main-8081', 'service', line);
    }, [instances.length, appendInstanceLog]),
    useCallback((line: string) => {
      appendInstanceLog('main-8081', 'metro', line);
    }, [appendInstanceLog]),
    useCallback((line: string) => {
      appendInstanceLog('main-8081', 'service', line);
    }, [appendInstanceLog]),
    handleSimulatedSectionEvent,
  );

  // Get the current active instance and its logs
  const activeInstance = instances.find(i => i.id === activeId) ?? null;
  const activeLogs = activeId ? instanceLogsRef.current.get(activeId) ?? makeEmptyLogs() : makeEmptyLogs();

  const activeProfile: ProfileInfo = activeInstance
    ? {
        name: activeInstance.id,
        branch: activeInstance.branch,
        platform: activeInstance.platform,
        dirty: true,
        port: activeInstance.port,
        buildType: 'debug',
      }
    : { name: '-', branch: '-', platform: '-', dirty: true, port: 0, buildType: '-' };

  // Keyboard shortcuts
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const sel = window.getSelection();
      if (sel && sel.toString().length > 0) return;
      if ((e.target as HTMLElement).tagName === 'INPUT' || (e.target as HTMLElement).tagName === 'TEXTAREA') return;

      switch (e.key) {
        case 'r':
          invoke('metro:reload');
          break;
        case 'd':
          invoke('metro:devMenu');
          break;
        case 'l':
          invoke('run:lint');
          break;
        case 't':
          invoke('run:typecheck');
          break;
        case 'c':
          invoke('run:clean');
          break;
        case 'w':
          invoke('watcher:toggle');
          break;
        case 'o':
          invoke('logs:dump');
          break;
        case 'f':
          break;
        case 'p':
          setProfileVisible((v) => !v);
          break;
        case 'q':
          window.close();
          break;
        case 'Tab':
          e.preventDefault();
          const tabs: string[] = [
            'dev-space',
            'devtools',
            'lint-test',
            'metro-logs',
            'marketplace',
            'settings',
            ...modulePanels.map((p) => `module:${p.moduleId}:${p.panelId}`),
          ];
          const idx = tabs.indexOf(activeTab);
          setActiveTab(tabs[(idx + 1) % tabs.length]);
          break;
      }
    };

    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [activeTab, invoke, modulePanels]);

  const handleShortcut = useCallback((command: string) => {
    invoke(command);
    if (activeId) {
      appendInstanceLog(activeId, 'service', `> ${command}...`);
    }
  }, [invoke, activeId, appendInstanceLog]);

  // Instance tab actions
  const handleSelectInstance = useCallback((id: string) => {
    setActiveId(id);
    invoke('instances:setActive', id);
  }, [invoke]);

  const handleCloseInstance = useCallback((id: string) => {
    invoke('instances:remove', id);
  }, [invoke]);

  const handleAddInstance = useCallback(() => {
    setShowNewInstanceDialog(true);
  }, []);

  const handleDialogSelectProfile = useCallback((profileName: string) => {
    setShowNewInstanceDialog(false);
    invoke('instances:create', profileName);
    // instance:created event will add the new tab
  }, [invoke]);

  const handleDialogCreateNew = useCallback(() => {
    setShowNewInstanceDialog(false);
    setShowWizard(true);
  }, []);

  const handleDialogCancel = useCallback(() => {
    setShowNewInstanceDialog(false);
  }, []);

  const handleWizardComplete = useCallback((profileName: string) => {
    setShowWizard(false);
    // Create an instance from the newly saved profile
    invoke('instances:create', profileName);
  }, [invoke]);

  const handleWizardCancel = useCallback(() => {
    setShowWizard(false);
  }, []);

  const sidebarPanels: SidebarModulePanel[] = modulePanels.map((p) => ({
    id: `module:${p.moduleId}:${p.panelId}`,
    title: p.title,
    icon: p.icon,
  }));

  const renderView = () => {
    // Module-contributed panels are keyed `module:<moduleId>:<panelId>`.
    if (activeTab.startsWith('module:')) {
      const rest = activeTab.slice('module:'.length);
      const colon = rest.indexOf(':');
      if (colon > 0) {
        const moduleId = rest.slice(0, colon);
        const panelId = rest.slice(colon + 1);
        // Key by tab id so switching between panels re-mounts cleanly
        // and ModulePanel's deactivate/activate cycle fires.
        return <ModulePanel key={activeTab} moduleId={moduleId} panelId={panelId} />;
      }
    }

    switch (activeTab) {
      case 'dev-space':
        return (
          <DevSpace
            serviceLines={activeLogs.serviceLines}
            metroLines={activeLogs.metroLines}
            sections={activeLogs.sections}
            instanceId={activeId ?? ''}
            onToggleSection={(sectionId) => handleToggleSection(activeId ?? '', sectionId)}
            onRetrySection={(sectionId) => handleRetrySection(activeId ?? '', sectionId)}
          />
        );
      case 'devtools':
        return <DevToolsView metroPort={activeProfile.port} />;
      case 'lint-test':
        return <LintTest />;
      case 'metro-logs':
        return <MetroLogs lines={activeLogs.metroLines} />;
      case 'settings':
        return <Settings />;
      case 'marketplace':
        return <Marketplace />;
      default:
        return null;
    }
  };

  if (showNewInstanceDialog) {
    return (
      <div className="app-root">
        <Sidebar activeTab={activeTab} onTabChange={setActiveTab} onShortcut={handleShortcut} onOpenWizard={() => setShowWizard(true)} modulePanels={sidebarPanels} />
        <div className="app-main">
          {instances.length > 0 && (
            <InstanceTabs
              instances={instances}
              activeId={activeId}
              onSelect={handleSelectInstance}
              onClose={handleCloseInstance}
              onAdd={handleAddInstance}
            />
          )}
          <div className="app-content">
            <NewInstanceDialog
              onSelectProfile={handleDialogSelectProfile}
              onCreateNew={handleDialogCreateNew}
              onCancel={handleDialogCancel}
            />
          </div>
        </div>
      </div>
    );
  }

  if (showWizard) {
    return (
      <div className="app-root">
        <Sidebar activeTab={activeTab} onTabChange={setActiveTab} onShortcut={handleShortcut} onOpenWizard={() => setShowWizard(true)} modulePanels={sidebarPanels} />
        <div className="app-main">
          {instances.length > 0 && (
            <InstanceTabs
              instances={instances}
              activeId={activeId}
              onSelect={handleSelectInstance}
              onClose={handleCloseInstance}
              onAdd={handleAddInstance}
            />
          )}
          <div className="app-content">
            <Wizard
              onComplete={handleWizardComplete}
              onCancel={handleWizardCancel}
            />
          </div>
        </div>
      </div>
    );
  }

  // If no instances exist at all (no profile, waiting), show wizard
  if (instances.length === 0 && !window.rndev) {
    // Browser-only mode will auto-create a simulated instance
  }

  return (
    <div className="app-root">
      <Sidebar activeTab={activeTab} onTabChange={setActiveTab} onShortcut={handleShortcut} onOpenWizard={() => setShowWizard(true)} modulePanels={sidebarPanels} />
      <div className="app-main">
        <InstanceTabs
          instances={instances}
          activeId={activeId}
          onSelect={handleSelectInstance}
          onClose={handleCloseInstance}
          onAdd={handleAddInstance}
        />
        <ProfileBanner
          profile={activeProfile}
          visible={profileVisible}
          onToggle={() => setProfileVisible((v) => !v)}
        />
        <div className="app-content">
          {promptModal ? (
            <div className="prompt-overlay">
              <div className="prompt-modal">
                <h3 className="prompt-title">{promptModal.title}</h3>
                <p className="prompt-message">{promptModal.message}</p>
                <div className="prompt-options">
                  {promptModal.options.map((opt) => (
                    <button
                      key={opt.value}
                      className="prompt-option"
                      onClick={() => {
                        invoke(`prompt:respond:${promptModal.promptId}`, { value: opt.value });
                        setPromptModal(null);
                      }}
                    >
                      <span className="prompt-option-label">{opt.label}</span>
                      {opt.cleanup && (
                        <span className="prompt-option-cleanup">🗑 {opt.cleanup}</span>
                      )}
                    </button>
                  ))}
                </div>
              </div>
            </div>
          ) : renderView()}
        </div>
        <StatusBar
          metroStatus={(activeInstance?.metroStatus as any) ?? 'stopped'}
          metroPort={activeProfile.port}
          watcherOn={true}
          activeTab={activeTab}
        />
      </div>
    </div>
  );
}
