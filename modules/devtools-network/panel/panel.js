// Panel client for devtools-network. Runs in an isolated WebContentsView
// spawned by the rn-dev panel-bridge — the preload exposes `window.rnDev`
// with `callTool(tool, args?)` for invoking this module's own subprocess
// tools.
//
// Poll cadence: 2 seconds while the panel is visible. The module's
// `list` tool returns the current ring contents; drawing is idempotent
// so we can re-render on every tick without flicker.

/* global window, document, setInterval, clearInterval */

// IIFE wrap: the preload exposes `window.rnDev` via
// `contextBridge.exposeInMainWorld`, which defines `rnDev` as a
// NON-CONFIGURABLE global property. A top-level `const rnDev` in a classic
// <script> would then hit the "restricted global property" rule and throw
// `SyntaxError: Identifier 'rnDev' has already been declared` at parse time,
// aborting the whole script (panel stuck on its initial content). Function
// scope makes `const rnDev` a local binding that shadows the global property.
(() => {
const rnDev = /** @type {any} */ (window).rnDev;
const contentEl = document.getElementById("content");
const statusEl = document.getElementById("status");
const refreshBtn = document.getElementById("refresh");
const clearBtn = document.getElementById("clear");

const POLL_INTERVAL_MS = 2000;
let pollTimer = null;
let inFlight = false;
let lastError = null;

async function refresh({ force = false } = {}) {
  if (!rnDev || typeof rnDev.callTool !== "function") {
    renderFatal("Panel preload unavailable \u2014 open the Network panel from the sidebar.");
    return;
  }
  if (inFlight && !force) return;
  inFlight = true;
  try {
    const reply = await rnDev.callTool("list", {});
    if (reply?.kind === "error") {
      renderFatal(`${reply.code}: ${reply.message}`);
      return;
    }
    const result = reply?.result ?? reply;
    lastError = null;
    renderEntries(result);
  } catch (err) {
    renderFatal(err instanceof Error ? err.message : String(err));
  } finally {
    inFlight = false;
  }
}

async function doClear() {
  if (!rnDev || typeof rnDev.callTool !== "function") return;
  clearBtn.disabled = true;
  try {
    await rnDev.callTool("clear", {});
    await refresh({ force: true });
  } catch (err) {
    renderFatal(err instanceof Error ? err.message : String(err));
  } finally {
    clearBtn.disabled = false;
  }
}

function renderFatal(message) {
  lastError = message;
  statusEl.hidden = true;
  contentEl.replaceChildren();
  const div = document.createElement("div");
  div.className = "error";
  div.textContent = message;
  contentEl.appendChild(div);
}

function renderEntries(result) {
  const entries = Array.isArray(result?.entries) ? result.entries : [];
  const meta = result?.meta ?? null;

  renderStatus(meta, entries.length);

  if (entries.length === 0) {
    const empty = document.createElement("div");
    empty.className = "empty";
    const refusal = captureRefusalText(meta);
    if (refusal) {
      // Connected target that ACCEPTED the socket but REFUSED the
      // capture domain \u2014 without this the panel showed "Waiting for
      // network activity\u2026" forever with no hint (2026-06-11 acme iOS:
      // react-native-worklets registers a second RN host, so RN refuses
      // Network.enable). Tell the human why it will never fill.
      empty.className = "empty error";
      empty.textContent = refusal;
    } else {
      empty.textContent =
        meta?.proxyStatus === "connected"
          ? "Waiting for network activity\u2026"
          : "No captures yet.";
    }
    contentEl.replaceChildren(empty);
    return;
  }

  // Newest last in the ring; render reversed so latest is at the top.
  const rows = [...entries].reverse();

  const table = document.createElement("table");
  const thead = document.createElement("thead");
  const headerRow = document.createElement("tr");
  for (const [cls, label] of [
    ["col-method", "Method"],
    ["col-status", "Status"],
    ["col-dur", "Duration"],
    ["col-url", "URL"],
  ]) {
    const th = document.createElement("th");
    th.className = cls;
    th.textContent = label;
    headerRow.appendChild(th);
  }
  thead.appendChild(headerRow);
  const tbody = document.createElement("tbody");
  for (const entry of rows) {
    tbody.appendChild(renderRow(entry));
  }
  table.appendChild(thead);
  table.appendChild(tbody);
  contentEl.replaceChildren(table);
}

function renderRow(entry) {
  const tr = document.createElement("tr");

  const method = document.createElement("td");
  method.className = "col-method";
  method.textContent = (entry.method || "").toUpperCase();

  const status = document.createElement("td");
  status.className = `col-status ${statusClass(entry)}`;
  status.textContent = statusText(entry);

  const dur = document.createElement("td");
  dur.className = "col-dur dur";
  dur.textContent = durationText(entry);

  const url = document.createElement("td");
  url.className = "col-url";
  url.textContent = truncate(entry.url || "", 160);
  url.title = entry.url || "";

  tr.appendChild(method);
  tr.appendChild(status);
  tr.appendChild(dur);
  tr.appendChild(url);
  return tr;
}

function statusClass(entry) {
  if (entry.terminalState === "pending") return "status-pending";
  if (entry.terminalState === "failed") return "status-err";
  const code = Number(entry.status);
  if (!Number.isFinite(code)) return "status-ok";
  if (code >= 500) return "status-5xx";
  if (code >= 400) return "status-4xx";
  if (code >= 300) return "status-redir";
  return "status-ok";
}

function statusText(entry) {
  if (entry.terminalState === "pending") return "\u2026";
  if (entry.terminalState === "failed") return "err";
  return String(entry.status ?? "");
}

function durationText(entry) {
  if (entry.terminalState === "pending") return "\u2014";
  const ms = Math.round(entry?.timings?.durationMs ?? 0);
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function renderStatus(meta, entryCount) {
  if (!meta) {
    statusEl.hidden = true;
    return;
  }
  const proxyClass =
    meta.proxyStatus === "connected"
      ? "status-value status-value--ok"
      : meta.proxyStatus === "disconnected" || meta.proxyStatus === "no-target"
        ? "status-value status-value--warn"
        : "status-value";
  const children = [
    labelSpan("Proxy:"),
    valueSpan(meta.proxyStatus || "unknown", proxyClass),
    labelSpan("Entries:"),
    valueSpan(String(entryCount)),
    labelSpan("Evicted:"),
    valueSpan(String(meta.evictedCount ?? 0)),
    labelSpan("Bodies:"),
    valueSpan(meta.bodyCapture || "unknown"),
  ];
  // A connected proxy can still be refusing the capture domain — surface
  // it inline so the status line never reads healthy while empty.
  if (Array.isArray(meta.enableErrors) && meta.enableErrors.length > 0) {
    children.push(
      labelSpan("Capture:"),
      valueSpan("refused", "status-value status-value--warn"),
    );
  }
  statusEl.replaceChildren(...children);
  statusEl.hidden = false;
}

/**
 * Human-facing explanation when the target accepted the inspector socket
 * but a capture enable command was refused (CaptureMeta.enableErrors).
 * Returns null when capture is healthy. The Network.enable multi-hosts
 * case gets a worklets hint because that is the one that bites Acme
 * iOS (react-native-worklets registering a second RN host).
 */
function captureRefusalText(meta) {
  const errs = Array.isArray(meta?.enableErrors) ? meta.enableErrors : [];
  if (errs.length === 0) return null;
  const net = errs.find((e) => e && e.method === "Network.enable");
  if (net && /multiple React Native hosts/i.test(net.message || "")) {
    return (
      "Network capture refused: the app registers multiple React Native " +
      "hosts, so RN disables the Network domain. On Acme iOS this is " +
      "react-native-worklets — apply patches/react-native-worklets*.patch " +
      "(or upgrade worklets ≥ 0.9) and rebuild."
    );
  }
  const first = errs[0];
  return `Capture refused: ${first.method} — ${first.message || "enable command rejected"}`;
}

function labelSpan(text) {
  const span = document.createElement("span");
  span.className = "status-label";
  span.textContent = text;
  return span;
}

function valueSpan(text, cls = "status-value") {
  const span = document.createElement("span");
  span.className = cls;
  span.textContent = text;
  return span;
}

function truncate(s, max) {
  if (s.length <= max) return s;
  const q = s.indexOf("?");
  const base = q >= 0 ? s.slice(0, q) : s;
  if (base.length <= max) return `${base}\u2026`;
  return `${base.slice(0, max - 1)}\u2026`;
}

function startPolling() {
  stopPolling();
  pollTimer = setInterval(() => {
    if (lastError) return; // wait for manual refresh after a failure
    refresh();
  }, POLL_INTERVAL_MS);
}

function stopPolling() {
  if (pollTimer !== null) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
}

refreshBtn.addEventListener("click", () => refresh({ force: true }));
clearBtn.addEventListener("click", doClear);

document.addEventListener("visibilitychange", () => {
  if (document.hidden) stopPolling();
  else {
    refresh({ force: true });
    startPolling();
  }
});

refresh({ force: true });
startPolling();
})();
