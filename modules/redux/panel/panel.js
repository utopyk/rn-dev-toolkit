// Panel client for redux. Runs in an isolated WebContentsView spawned by
// the rn-dev panel-bridge; `window.rnDev.callTool(tool, args?)` invokes
// this module's own subprocess tools (short names — the bridge prepends
// the module id). Polls every 2s while visible.
//
// Values arrive already redacted (host-side). A `"[redacted]"` string or a
// `"<type>"` placeholder is rendered dimmed so a human can tell "hidden by
// policy" from real data.

/* global window, document, setInterval, clearInterval */

const rnDev = /** @type {any} */ (window).rnDev;
const statusEl = document.getElementById("status");
const actionsEl = document.getElementById("actions");
const detailEl = document.getElementById("detail");
const detailTitle = document.getElementById("detail-title");
const refreshBtn = document.getElementById("refresh");
const clearBtn = document.getElementById("clear");

const POLL_INTERVAL_MS = 2000;
let pollTimer = null;
let inFlight = false;
let lastError = null;
/** Selected action sequence, or null to show current state. */
let selectedSeq = null;
let lastActions = [];

async function call(tool, args = {}) {
  const reply = await rnDev.callTool(tool, args);
  if (reply?.kind === "error") throw new Error(`${reply.code}: ${reply.message}`);
  return reply?.result ?? reply;
}

async function refresh({ force = false } = {}) {
  if (!rnDev || typeof rnDev.callTool !== "function") {
    renderFatal("Panel preload unavailable — open the Redux panel from the sidebar.");
    return;
  }
  if (inFlight && !force) return;
  inFlight = true;
  try {
    const [statusRes, actionsRes] = await Promise.all([call("status"), call("actions", { limit: 200 })]);
    lastError = null;
    renderStatus(statusRes);
    renderActions(actionsRes);
    await renderDetail();
  } catch (err) {
    renderFatal(err instanceof Error ? err.message : String(err));
  } finally {
    inFlight = false;
  }
}

async function doClear() {
  if (!rnDev) return;
  clearBtn.disabled = true;
  try {
    await call("clear");
    selectedSeq = null;
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
  const div = document.createElement("div");
  div.className = "error";
  div.textContent = message;
  actionsEl.replaceChildren(div.cloneNode(true));
  detailEl.replaceChildren(div);
}

function renderStatus(st) {
  const meta = st?.meta;
  if (!meta) {
    statusEl.hidden = true;
    return;
  }
  const stateClass = meta.hasState ? "status-value status-value--ok" : "status-value status-value--warn";
  statusEl.replaceChildren(
    label("Actions:"), value(String(st.bufferSize ?? 0)),
    label("State:"), value(meta.hasState ? "captured" : "waiting", stateClass),
    label("Redaction:"), value(meta.redactionMode ?? "unknown"),
    label("Evicted:"), value(String(meta.evictedCount ?? 0)),
  );
  statusEl.hidden = false;
}

function renderActions(res) {
  const entries = Array.isArray(res?.entries) ? res.entries : [];
  lastActions = entries;
  if (entries.length === 0) {
    actionsEl.replaceChildren(emptyDiv("No actions captured yet."));
    return;
  }
  const table = document.createElement("table");
  const tbody = document.createElement("tbody");
  // Newest first.
  for (const a of [...entries].reverse()) {
    const tr = document.createElement("tr");
    tr.className = "action-row" + (a.sequence === selectedSeq ? " selected" : "");
    tr.appendChild(cell("col-seq", String(a.sequence)));
    tr.appendChild(cell("col-type", a.type ?? "?"));
    tr.appendChild(cell("col-time", formatTime(a.at)));
    tr.addEventListener("click", () => {
      selectedSeq = selectedSeq === a.sequence ? null : a.sequence;
      void refresh({ force: true });
    });
    tbody.appendChild(tr);
  }
  table.appendChild(tbody);
  actionsEl.replaceChildren(table);
}

async function renderDetail() {
  if (selectedSeq === null) {
    detailTitle.textContent = "State";
    const st = await call("state", {});
    if (!st?.present) {
      detailEl.replaceChildren(emptyDiv("No state snapshot yet."));
      return;
    }
    detailEl.replaceChildren(pre(st.value));
    return;
  }
  detailTitle.textContent = `Action #${selectedSeq}`;
  const found = lastActions.find((a) => a.sequence === selectedSeq);
  if (!found) {
    detailEl.replaceChildren(emptyDiv("Action no longer in buffer."));
    return;
  }
  detailEl.replaceChildren(pre({ type: found.type, payload: found.payload, diff: found.diff }));
}

function pre(value) {
  const el = document.createElement("pre");
  el.textContent = JSON.stringify(value, null, 2);
  return el;
}

function cell(cls, text) {
  const td = document.createElement("td");
  td.className = cls;
  td.textContent = text;
  return td;
}
function label(text) {
  const s = document.createElement("span");
  s.className = "status-label";
  s.textContent = text + " ";
  return s;
}
function value(text, cls = "status-value") {
  const s = document.createElement("span");
  s.className = cls;
  s.textContent = text;
  return s;
}
function emptyDiv(text) {
  const d = document.createElement("div");
  d.className = "empty";
  d.textContent = text;
  return d;
}
function formatTime(at) {
  if (typeof at !== "number") return "";
  const d = new Date(at);
  return d.toLocaleTimeString(undefined, { hour12: false }) + "." + String(d.getMilliseconds()).padStart(3, "0");
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
