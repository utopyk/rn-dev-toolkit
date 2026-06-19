// Panel client for redux. Runs in an isolated WebContentsView spawned by
// the rn-dev panel-bridge; `window.rnDev.callTool(tool, args?)` invokes
// this module's own subprocess tools (short names — the bridge prepends
// the module id).
//
// Layout (react-native-debugger style): left = action list (filterable);
// right = Action / State / Diff tabs over a collapsible, searchable JSON
// tree. "Reveal values" requests `mode:"full"` (real values; the host's
// secret blacklist still masks tokens/email/etc.); off = structure-only.

/* global window, document, setInterval, clearInterval, Date */

// IIFE wrap: the preload exposes `window.rnDev` via
// `contextBridge.exposeInMainWorld`, which defines `rnDev` as a
// NON-CONFIGURABLE global property. A top-level `const rnDev` in a classic
// <script> would then hit the "restricted global property" rule and throw
// `SyntaxError: Identifier 'rnDev' has already been declared` at parse time,
// aborting the whole script. Function scope makes `const rnDev` a local
// binding that shadows the global property — no clash.
(() => {
const rnDev = /** @type {any} */ (window).rnDev;
const statusEl = document.getElementById("status");
const actionsEl = document.getElementById("actions");
const detailEl = document.getElementById("detail");
const refreshBtn = document.getElementById("refresh");
const clearBtn = document.getElementById("clear");
const revealEl = /** @type {any} */ (document.getElementById("reveal"));
const tabsEl = document.getElementById("tabs");
const actionSearchEl = /** @type {any} */ (document.getElementById("action-search"));
const detailSearchEl = /** @type {any} */ (document.getElementById("detail-search"));

const POLL_INTERVAL_MS = 2000;
let pollTimer = null;
let inFlight = false;
let lastError = null;
let selectedSeq = null;
let activeTab = "state"; // "action" | "state" | "diff"
let lastActions = [];
let lastState = { present: false, value: undefined };

function mode() {
  return revealEl && revealEl.checked ? "full" : "mcp-redacted";
}

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
    const m = mode();
    const [statusRes, actionsRes, stateRes] = await Promise.all([
      call("status"),
      call("actions", { limit: 200, mode: m }),
      call("state", { mode: m }),
    ]);
    lastError = null;
    lastActions = Array.isArray(actionsRes?.entries) ? actionsRes.entries : [];
    lastState = stateRes && typeof stateRes === "object" ? stateRes : { present: false };
    renderStatus(statusRes);
    renderActions();
    renderDetail();
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
  if (!meta) { statusEl.hidden = true; return; }
  const stateClass = meta.hasState ? "status-value status-value--ok" : "status-value status-value--warn";
  statusEl.replaceChildren(
    label("Actions:"), value(String(st.bufferSize ?? 0)),
    label("State:"), value(meta.hasState ? "captured" : "waiting", stateClass),
    label("Redaction:"), value(mode() === "full" ? "full (values shown)" : "structure-only"),
    label("Evicted:"), value(String(meta.evictedCount ?? 0)),
  );
  statusEl.hidden = false;
}

function renderActions() {
  const q = (actionSearchEl?.value ?? "").trim().toLowerCase();
  const entries = q ? lastActions.filter((a) => String(a.type ?? "").toLowerCase().includes(q)) : lastActions;
  if (entries.length === 0) {
    actionsEl.replaceChildren(emptyDiv(lastActions.length === 0 ? "No actions captured yet." : "No actions match the filter."));
    return;
  }
  const table = document.createElement("table");
  const tbody = document.createElement("tbody");
  for (const a of [...entries].reverse()) { // newest first
    const tr = document.createElement("tr");
    tr.className = "action-row" + (a.sequence === selectedSeq ? " selected" : "");
    tr.appendChild(cell("col-seq", String(a.sequence)));
    tr.appendChild(cell("col-type", a.type ?? "?"));
    tr.appendChild(cell("col-time", formatTime(a.at)));
    tr.addEventListener("click", () => {
      if (selectedSeq === a.sequence) {
        selectedSeq = null;
      } else {
        selectedSeq = a.sequence;
        if (activeTab === "state") setTab("action", { silent: true });
      }
      renderActions();
      renderDetail();
    });
    tbody.appendChild(tr);
  }
  table.appendChild(tbody);
  actionsEl.replaceChildren(table);
}

function setTab(tab, { silent = false } = {}) {
  activeTab = tab;
  for (const btn of tabsEl.querySelectorAll(".tab")) {
    btn.classList.toggle("active", btn.getAttribute("data-tab") === tab);
  }
  if (!silent) renderDetail();
}

function renderDetail() {
  const q = (detailSearchEl?.value ?? "").trim().toLowerCase();
  const selected = selectedSeq !== null ? lastActions.find((a) => a.sequence === selectedSeq) : null;

  if (activeTab === "state") {
    if (!lastState?.present) { detailEl.replaceChildren(emptyDiv("No state snapshot yet.")); return; }
    detailEl.replaceChildren(buildTree(lastState.value, q, 1));
    return;
  }
  if (!selected) {
    detailEl.replaceChildren(emptyDiv("Select an action to see its " + activeTab + "."));
    return;
  }
  if (activeTab === "action") {
    detailEl.replaceChildren(buildTree({ type: selected.type, payload: selected.payload }, q, 3));
  } else {
    detailEl.replaceChildren(buildTree(selected.diff, q, 4));
  }
}

// ── Collapsible, search-aware JSON tree ──────────────────────────────────

function buildTree(value, q, expandDepth) {
  const root = document.createElement("div");
  root.className = "tree";
  const node = renderNode(null, value, 0, q, expandDepth);
  if (!node) { root.appendChild(emptyDiv("No keys/values match the search.")); return root; }
  root.appendChild(node);
  return root;
}

/** Returns the rendered element, or null when a search is active and neither
 *  this node nor any descendant matches. */
function renderNode(keyStr, value, depth, q, expandDepth) {
  const isObj = value !== null && typeof value === "object";
  if (!isObj) return makeLeaf(keyStr, value, q);

  const isArr = Array.isArray(value);
  const entries = isArr ? value.map((v, i) => [String(i), v]) : Object.entries(value);
  const keyMatch = !!q && keyStr !== null && keyStr.toLowerCase().includes(q);

  const childWrap = document.createElement("div");
  childWrap.className = "tchildren";
  let anyChild = false;
  for (const [k, v] of entries) {
    const child = renderNode(k, v, depth + 1, q, expandDepth);
    if (child) { childWrap.appendChild(child); anyChild = true; }
  }
  if (q && !keyMatch && !anyChild) return null;

  const node = document.createElement("div");
  node.className = "tnode";
  const row = document.createElement("div");
  row.className = "trow";

  const expanded = q ? anyChild : depth < expandDepth;
  const toggle = document.createElement("span");
  toggle.className = "ttoggle";
  toggle.textContent = entries.length === 0 ? "" : expanded ? "▼" : "▶";
  row.appendChild(toggle);

  if (keyStr !== null) {
    const k = document.createElement("span");
    k.className = "tkey" + (keyMatch ? " thit" : "");
    k.textContent = keyStr;
    row.appendChild(k);
    const colon = document.createElement("span");
    colon.className = "tcolon";
    colon.textContent = ":";
    row.appendChild(colon);
  }
  const sum = document.createElement("span");
  sum.className = "tsummary";
  sum.textContent = isArr ? `[ ${entries.length} ]` : `{ ${entries.length} }`;
  row.appendChild(sum);

  node.appendChild(row);
  childWrap.style.display = expanded ? "" : "none";
  node.appendChild(childWrap);

  if (entries.length > 0) {
    const toggleFn = () => {
      const hidden = childWrap.style.display === "none";
      childWrap.style.display = hidden ? "" : "none";
      toggle.textContent = hidden ? "▼" : "▶";
    };
    toggle.addEventListener("click", toggleFn);
    sum.addEventListener("click", toggleFn);
    const keyEl = row.querySelector(".tkey");
    if (keyEl) keyEl.addEventListener("click", toggleFn);
  }
  return node;
}

function makeLeaf(keyStr, value, q) {
  const info = leafInfo(value);
  const keyMatch = !!q && keyStr !== null && keyStr.toLowerCase().includes(q);
  const valMatch = !!q && info.text.toLowerCase().includes(q);
  if (q && !keyMatch && !valMatch) return null;

  const node = document.createElement("div");
  node.className = "tnode";
  const row = document.createElement("div");
  row.className = "trow";
  const spacer = document.createElement("span");
  spacer.className = "ttoggle";
  row.appendChild(spacer);
  if (keyStr !== null) {
    const k = document.createElement("span");
    k.className = "tkey" + (keyMatch ? " thit" : "");
    k.textContent = keyStr;
    row.appendChild(k);
    const colon = document.createElement("span");
    colon.className = "tcolon";
    colon.textContent = ":";
    row.appendChild(colon);
  }
  const v = document.createElement("span");
  v.className = info.cls + (valMatch ? " thit" : "");
  v.textContent = info.text;
  row.appendChild(v);
  node.appendChild(row);
  return node;
}

function leafInfo(value) {
  if (value === null) return { cls: "tnull", text: "null" };
  if (value === undefined) return { cls: "tnull", text: "undefined" };
  if (typeof value === "number") return { cls: "tnumber", text: String(value) };
  if (typeof value === "boolean") return { cls: "tbool", text: String(value) };
  if (typeof value === "string") {
    if (value === "[redacted]") return { cls: "tredacted", text: "[redacted]" };
    if (/^<.+>$/.test(value)) return { cls: "ttype", text: value }; // structure-only placeholder
    return { cls: "tstring", text: JSON.stringify(value) };
  }
  return { cls: "tstring", text: String(value) };
}

// ── small DOM helpers ────────────────────────────────────────────────────

function cell(cls, text) { const td = document.createElement("td"); td.className = cls; td.textContent = text; return td; }
function label(text) { const s = document.createElement("span"); s.className = "status-label"; s.textContent = text + " "; return s; }
function value(text, cls = "status-value") { const s = document.createElement("span"); s.className = cls; s.textContent = text; return s; }
function emptyDiv(text) { const d = document.createElement("div"); d.className = "empty"; d.textContent = text; return d; }
function formatTime(at) {
  if (typeof at !== "number") return "";
  const d = new Date(at);
  return d.toLocaleTimeString(undefined, { hour12: false }) + "." + String(d.getMilliseconds()).padStart(3, "0");
}

function startPolling() {
  stopPolling();
  pollTimer = setInterval(() => { if (!lastError) refresh(); }, POLL_INTERVAL_MS);
}
function stopPolling() {
  if (pollTimer !== null) { clearInterval(pollTimer); pollTimer = null; }
}

// ── wiring ───────────────────────────────────────────────────────────────

refreshBtn.addEventListener("click", () => refresh({ force: true }));
clearBtn.addEventListener("click", doClear);
if (revealEl) revealEl.addEventListener("change", () => refresh({ force: true }));
if (actionSearchEl) actionSearchEl.addEventListener("input", renderActions);
if (detailSearchEl) detailSearchEl.addEventListener("input", renderDetail);
for (const btn of tabsEl.querySelectorAll(".tab")) {
  btn.addEventListener("click", () => setTab(btn.getAttribute("data-tab")));
}
document.addEventListener("visibilitychange", () => {
  if (document.hidden) stopPolling();
  else { refresh({ force: true }); startPolling(); }
});

refresh({ force: true });
startPolling();
})();
