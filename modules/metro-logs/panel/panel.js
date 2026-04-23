// Panel client for metro-logs. Runs in an isolated WebContentsView
// spawned by the rn-dev panel-bridge — the preload exposes `window.rnDev`
// with `callTool(tool, args?)` for invoking this module's own subprocess
// tools.
//
// Uses DOM-builder APIs (no innerHTML) so log lines containing rogue HTML
// don't get rendered — Metro output is untrusted.

/* global window, document, setInterval, clearInterval */

const rnDev = /** @type {any} */ (window).rnDev;
const contentEl = document.getElementById("content");
const statusEl = document.getElementById("status");
const refreshBtn = document.getElementById("refresh");
const clearBtn = document.getElementById("clear");
const filterEl = /** @type {HTMLInputElement} */ (document.getElementById("filter"));
const streamEl = /** @type {HTMLSelectElement} */ (document.getElementById("stream"));
const followEl = /** @type {HTMLInputElement} */ (document.getElementById("follow"));

const POLL_INTERVAL_MS = 1000;
const MAX_ROWS = 500;
let pollTimer = null;
let inFlight = false;
let lastError = null;
let cursor = null;
const rows = [];

async function refresh({ force = false } = {}) {
  if (!rnDev || typeof rnDev.callTool !== "function") {
    renderFatal("Panel preload unavailable \u2014 open the Metro Logs panel from the sidebar.");
    return;
  }
  if (inFlight && !force) return;
  inFlight = true;
  try {
    const listArgs = {};
    const sub = filterEl.value.trim();
    if (sub.length > 0) listArgs.substring = sub;
    if (streamEl.value === "stdout" || streamEl.value === "stderr") {
      listArgs.stream = streamEl.value;
    }
    if (cursor) listArgs.since = cursor;
    const reply = await rnDev.callTool("list", listArgs);
    if (reply?.kind === "error") {
      renderFatal(`${reply.code}: ${reply.message}`);
      return;
    }
    const result = reply?.result ?? reply;
    lastError = null;
    ingest(result);
    render();
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
    rows.length = 0;
    cursor = null;
    await refresh({ force: true });
  } catch (err) {
    renderFatal(err instanceof Error ? err.message : String(err));
  } finally {
    clearBtn.disabled = false;
  }
}

function ingest(result) {
  if (!result) return;
  const entries = Array.isArray(result.entries) ? result.entries : [];
  const meta = result.meta ?? null;

  // Epoch bump or first fetch — replace the whole view. Server lost our
  // cursor's continuity, so seed from the current ring.
  if (!cursor || result.cursorDropped) {
    rows.length = 0;
    for (const e of entries) rows.push(e);
  } else {
    for (const e of entries) rows.push(e);
    if (rows.length > MAX_ROWS) {
      rows.splice(0, rows.length - MAX_ROWS);
    }
  }

  if (meta) {
    cursor = { bufferEpoch: meta.bufferEpoch, sequence: meta.lastEventSequence };
    renderStatus(meta, rows.length);
  }
}

function render() {
  if (rows.length === 0) {
    const empty = document.createElement("div");
    empty.className = "empty";
    empty.textContent = "No captured log lines yet.";
    contentEl.replaceChildren(empty);
    return;
  }
  const list = document.createElement("div");
  list.className = "log-list";
  for (const entry of rows) {
    list.appendChild(renderRow(entry));
  }
  contentEl.replaceChildren(list);
  if (followEl.checked) {
    list.scrollTop = list.scrollHeight;
  }
}

function renderRow(entry) {
  const row = document.createElement("div");
  row.className = `log-row ${entry.stream === "stderr" ? "stderr" : "stdout"}`;

  const seq = document.createElement("span");
  seq.className = "seq";
  seq.textContent = `#${entry.sequence}`;
  row.appendChild(seq);

  const text = document.createTextNode(entry.line ?? "");
  row.appendChild(text);
  return row;
}

function renderFatal(message) {
  lastError = message;
  statusEl.hidden = true;
  const div = document.createElement("div");
  div.className = "error";
  div.textContent = message;
  contentEl.replaceChildren(div);
}

function renderStatus(meta, entryCount) {
  if (!meta) {
    statusEl.hidden = true;
    return;
  }
  const statusClass =
    meta.metroStatus === "running"
      ? "status-value status-value--ok"
      : meta.metroStatus === "error"
        ? "status-value status-value--warn"
        : "status-value status-value--muted";
  const children = [
    labelSpan("Metro:"),
    valueSpan(meta.metroStatus || "idle", statusClass),
    labelSpan("Entries:"),
    valueSpan(String(entryCount)),
    labelSpan("Evicted:"),
    valueSpan(String(meta.evictedCount ?? 0)),
    labelSpan("Total:"),
    valueSpan(String(meta.totalLinesReceived ?? 0)),
  ];
  statusEl.replaceChildren(...children);
  statusEl.hidden = false;
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

function startPolling() {
  stopPolling();
  pollTimer = setInterval(() => {
    if (lastError) return;
    refresh();
  }, POLL_INTERVAL_MS);
}

function stopPolling() {
  if (pollTimer !== null) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
}

refreshBtn.addEventListener("click", () => {
  cursor = null;
  rows.length = 0;
  refresh({ force: true });
});
clearBtn.addEventListener("click", doClear);
filterEl.addEventListener("change", () => {
  cursor = null;
  rows.length = 0;
  refresh({ force: true });
});
streamEl.addEventListener("change", () => {
  cursor = null;
  rows.length = 0;
  refresh({ force: true });
});

document.addEventListener("visibilitychange", () => {
  if (document.hidden) stopPolling();
  else {
    refresh({ force: true });
    startPolling();
  }
});

refresh({ force: true });
startPolling();
