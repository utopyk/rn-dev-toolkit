// Host-renderer preload. Exposes a narrow `window.rndev` surface with an
// explicit channel allowlist — NOT a generic `invoke(anyChannel)` bridge.
// Security F5 (Phase 5c).
//
// The file is self-contained (data + predicates + contextBridge call) so
// the Electron preload loader doesn't have to resolve relative paths at
// runtime — an earlier split into preload-allowlist.cjs silently broke
// the preload and the renderer fell back to `useSimulatedLogs`. Vitest
// covers the predicates by requiring this file directly; the
// `require('electron')` call is wrapped so it no-ops under the test
// harness.
//
// To audit the renderer's real usage:
//   rg "invoke\('" renderer/       → INVOKE_EXACT / INVOKE_PREFIX
//   rg "useIpcOn\('" renderer/      → ON_EXACT

const INVOKE_EXACT = Object.freeze([
  // Profiles
  'profiles:list',
  'profiles:delete',
  'profiles:setDefault',

  // DevTools network proxy
  'devtools-network:proxy-port',
  'devtools-network:status',
  'devtools-network:restart',
  'devtools-network:select-target',

  // Wizard
  'wizard:createWorktree',
  'wizard:getWorktrees',
  'wizard:getBranches',
  'wizard:getDevices',
  'wizard:getPreflightChecks',
  'wizard:getTooling',
  'wizard:saveProfile',

  // Module-system panels + config
  'modules:activate-panel',
  'modules:set-panel-bounds',
  'modules:deactivate-panel',
  'modules:list-panels',
  'modules:list',
  'modules:config-get',
  'modules:config-set',

  // Open external (safe; opens editor via OS)
  'open:editor',

  // Instances
  'instances:list',
  'instances:getLogs',
  'instances:setActive',
  'instances:remove',
  'instances:create',
  'instance:retryStep',

  // Metro + runners + watcher + logs
  'metro:reload',
  'metro:devMenu',
  'run:lint',
  'run:typecheck',
  'run:clean',
  'watcher:toggle',
  'logs:dump',
]);

const INVOKE_PREFIX = Object.freeze([
  // Dynamic per-prompt response channels created in electron/ipc/services.ts
  'prompt:respond:',
]);

const ON_EXACT = Object.freeze([
  // Legacy + global logs
  'service:log',
  'metro:log',
  'build:line',

  // Per-instance stream events
  'instance:created',
  'instance:removed',
  'instance:log',
  'instance:metro',
  'instance:status',
  'instance:build:line',
  'instance:build:done',
  'instance:build:progress',
  'instance:prompt',
  'instance:section:start',
  'instance:section:end',

  // Module-system fan-out
  'modules:event',

  // DevTools network renderer subscription
  'devtools-network:change',
]);

function isAllowedInvoke(channel) {
  if (typeof channel !== 'string') return false;
  if (INVOKE_EXACT.includes(channel)) return true;
  return INVOKE_PREFIX.some(
    (p) => channel.startsWith(p) && channel.length > p.length,
  );
}

function isAllowedOn(channel) {
  return typeof channel === 'string' && ON_EXACT.includes(channel);
}

module.exports = {
  INVOKE_EXACT,
  INVOKE_PREFIX,
  ON_EXACT,
  isAllowedInvoke,
  isAllowedOn,
};

// Electron runtime binding. Wrapped so vitest can `require(this file)`
// to test the predicates without pulling in `electron`. When the import
// fails (non-Electron context) we just skip exposing the bridge — the
// predicate functions and arrays are still exported for tests.
let electron;
try {
  electron = require('electron');
} catch {
  electron = null;
}

if (electron && electron.contextBridge && electron.ipcRenderer) {
  const { contextBridge, ipcRenderer } = electron;
  contextBridge.exposeInMainWorld('rndev', {
    on: (channel, callback) => {
      if (!isAllowedOn(channel)) {
        console.error(`[preload] rejected on("${channel}") — not in allowlist`);
        return;
      }
      ipcRenderer.on(channel, (_event, ...args) => callback(...args));
    },
    off: (channel) => {
      if (!isAllowedOn(channel)) {
        console.error(`[preload] rejected off("${channel}") — not in allowlist`);
        return;
      }
      ipcRenderer.removeAllListeners(channel);
    },
    invoke: (channel, ...args) => {
      if (!isAllowedInvoke(channel)) {
        return Promise.reject(
          new Error(`[preload] rejected invoke("${channel}") — not in allowlist`),
        );
      }
      return ipcRenderer.invoke(channel, ...args);
    },
  });
}
