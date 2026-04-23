// Panel client for devtools-network. Runs in an isolated WebContentsView
// spawned by the rn-dev panel-bridge — the preload exposes `window.rnDev`
// with `callTool(tool, args?)` for invoking this module's own subprocess
// tools.
//
// Poll cadence: 2 seconds while the panel is visible. The module's
// `list` tool returns the current ring contents; drawing is idempotent
// so we can re-render on every tick without flicker.

/* global window, document, setInterval, clearInterval */

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
  contentEl.innerHTML = `<div class="error">${escapeHtml(message)}</div>`;
}

function renderEntries(result) {
  const entries = Array.isArray(result?.entries) ? result.entries : [];
  const meta = result?.meta ?? null;

  renderStatus(meta, entries.length);

  if (entries.length === 0) {
    const empty = document.createElement("div");
    empty.className = "empty";
    empty.textContent =
      meta?.proxyStatus === "connected"
        ? "Waiting for network activity\u2026"
        : "No captures yet.";
    contentEl.innerHTML = "";
    contentEl.appendChild(empty);
    return;
  }

  // Newest last in the ring; render reversed so latest is at the top.
  const rows = [...entries].reverse();

  const table = document.createElement("table");
  const thead = document.createElement("thead");
  thead.innerHTML = `
    <tr>
      <th class="col-method">Method</th>
      <th class="col-status">Status</th>
      <th class="col-dur">Duration</th>
      <th class="col-url">URL</th>
    </tr>
  `;
  const tbody = document.createElement("tbody");
  for (const entry of rows) {
    tbody.appendChild(renderRow(entry));
  }
  table.appendChild(thead);
  table.appendChild(tbody);
  contentEl.innerHTML = "";
  contentEl.appendChild(table);
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
  statusEl.innerHTML = `
    <span class="status-label">Proxy:</span>
    <span class="${proxyClass}">${escapeHtml(meta.proxyStatus || "unknown")}</span>
    <span class="status-label">Entries:</span>
    <span class="status-value">${entryCount}</span>
    <span class="status-label">Evicted:</span>
    <span class="status-value">${meta.evictedCount ?? 0}</span>
    <span class="status-label">Bodies:</span>
    <span class="status-value">${escapeHtml(meta.bodyCapture || "unknown")}</span>
  `;
  statusEl.hidden = false;
}

function truncate(s, max) {
  if (s.length <= max) return s;
  const q = s.indexOf("?");
  const base = q >= 0 ? s.slice(0, q) : s;
  if (base.length <= max) return `${base}\u2026`;
  return `${base.slice(0, max - 1)}\u2026`;
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
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
