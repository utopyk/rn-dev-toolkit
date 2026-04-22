// Per-module preload. Loaded into every WebContentsView created by
// `panel-bridge.ts`. Reads `--rn-dev-module-id=<id>` /
// `--rn-dev-panel-id=<id>` / `--rn-dev-host-api=<csv>` from
// process.additionalArguments and exposes exactly the allowlisted methods
// on `window.rnDev`.
//
// Security posture (Phase 4):
//   - `sandbox: true`, `contextIsolation: true`, `nodeIntegration: false` on
//     the WebContentsView. This preload runs in the isolated preload world;
//     anything exposed via `contextBridge.exposeInMainWorld` crosses the
//     isolation boundary via a structured-clone.
//   - The `hostApi[]` allowlist comes from the manifest and is TRUSTED
//     only in the sense that the main process populated it from the
//     validated manifest. The preload uses it verbatim — no wildcards, no
//     method inference.
//   - Every host call is audit-logged in the main process via IPC channel
//     `modules:host-call`. This preload doesn't write the audit log itself.

const { contextBridge, ipcRenderer } = require('electron');

// ---------------------------------------------------------------------------
// Parse additional-arguments
// ---------------------------------------------------------------------------

function parseArg(prefix) {
  for (const arg of process.argv) {
    if (arg.startsWith(prefix)) return arg.slice(prefix.length);
  }
  return '';
}

const moduleId = parseArg('--rn-dev-module-id=');
const panelId = parseArg('--rn-dev-panel-id=');
const hostApiRaw = parseArg('--rn-dev-host-api=');
const hostApi = hostApiRaw ? hostApiRaw.split(',').filter(Boolean) : [];

// ---------------------------------------------------------------------------
// Build the allowlisted surface
// ---------------------------------------------------------------------------

const api = {
  moduleId,
  panelId,
  hostApi: Object.freeze([...hostApi]),
};

// `call(methodDotted, ...args)` — entry point matching the SDK's
// `host.capability(id).method(args)` dispatch shape. Gated by `hostApi[]`.
// `methodDotted` is `"<capabilityId>.<method>"`.
api.call = async function call(methodDotted, ...args) {
  if (typeof methodDotted !== 'string') {
    throw new Error('rnDev.call: first argument must be a string');
  }
  if (!hostApi.includes(methodDotted)) {
    throw new Error(
      `rnDev.call: "${methodDotted}" is not in this panel's hostApi allowlist`,
    );
  }
  const dotIdx = methodDotted.indexOf('.');
  if (dotIdx <= 0 || dotIdx === methodDotted.length - 1) {
    throw new Error(
      `rnDev.call: method "${methodDotted}" must be "<capabilityId>.<method>"`,
    );
  }
  const capabilityId = methodDotted.slice(0, dotIdx);
  const method = methodDotted.slice(dotIdx + 1);
  return ipcRenderer.invoke('modules:host-call', {
    moduleId,
    capabilityId,
    method,
    args,
  });
};

// Also convenience: direct property access like `rnDev.adb.shell(...)` by
// constructing per-capability objects from the allowlist.
const capabilities = {};
for (const entry of hostApi) {
  const dotIdx = entry.indexOf('.');
  if (dotIdx <= 0) continue;
  const capId = entry.slice(0, dotIdx);
  const method = entry.slice(dotIdx + 1);
  if (!capabilities[capId]) capabilities[capId] = {};
  capabilities[capId][method] = async function (...args) {
    return ipcRenderer.invoke('modules:host-call', {
      moduleId,
      capabilityId: capId,
      method,
      args,
    });
  };
}
api.capabilities = Object.freeze(capabilities);

contextBridge.exposeInMainWorld('rnDev', api);
