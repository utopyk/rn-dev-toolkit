// Panel client for redux. Runs in an isolated WebContentsView spawned by
// the rn-dev panel-bridge; `window.rnDev.callTool(tool, args?)` invokes
// this module's own subprocess tools (short names — the bridge prepends
// the module id).
//
// Layout (react-native-debugger style): left = action list (filterable);
// right = Action / State / Diff tabs over a collapsible, searchable JSON
// tree. "Reveal values" requests `mode:"full"` (real values; the host's
// secret blacklist still masks tokens/email/etc.); off = structure-only.
// The Diff tab shows a unified old→new view (changed leaves only).

/* global window, document, setInterval, clearInterval, Date */

// IIFE wrap: the preload exposes `window.rnDev` via
// `contextBridge.exposeInMainWorld`, which defines `rnDev` as a
// NON-CONFIGURABLE global property. A top-level `const rnDev` in a classic
// <script> would then hit the "restricted global property" rule and throw
// `SyntaxError: Identifier 'rnDev' has already been declared` at parse time.
// Function scope makes `const rnDev` a local binding that shadows the global.
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
// Persisted expand/collapse per node path (keyed by `${tab}:${path}`), so
// the 2s poll re-render never clobbers what the user opened.
const expandState = new Map();
// Signature of the last-rendered detail; identical signature ⇒ skip the
// rebuild entirely (no flicker, no scroll reset, no lost expansion).
let lastDetailSig = "";

function mode() { return revealEl && revealEl.checked ? "full" : "mcp-redacted"; }
function isObj(v) { return v !== null && typeof v === "object"; }
function hashData(v) { try { return JSON.stringify(v) ?? "u"; } catch { return "x"; } }

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
    renderDetail({ force }); // force a rebuild only on explicit user actions
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
    expandState.clear();
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
  lastDetailSig = "error:" + message;
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
      renderDetail({ force: true });
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
  if (!silent) renderDetail({ force: true });
}

// ── Detail (signature-gated to survive polling) ──────────────────────────

function detailSignature(q) {
  const sel = selectedSeq;
  const a = sel !== null ? lastActions.find((x) => x.sequence === sel) : null;
  if (activeTab === "state") return "state|" + q + "|" + (lastState?.present ? hashData(lastState.value) : "none");
  if (!a) return activeTab + "|" + q + "|none";
  if (activeTab === "action") return "action|" + q + "|" + sel + "|" + hashData({ type: a.type, payload: a.payload });
  return "diff|" + q + "|" + sel + "|" + hashData(a.diff);
}

function renderDetail({ force = false } = {}) {
  const q = (detailSearchEl?.value ?? "").trim().toLowerCase();
  const sig = detailSignature(q);
  // Identical data/tab/filter ⇒ leave the DOM alone. This is what stops the
  // poll from collapsing keys the user expanded.
  if (!force && sig === lastDetailSig) return;
  lastDetailSig = sig;

  const selected = selectedSeq !== null ? lastActions.find((a) => a.sequence === selectedSeq) : null;

  if (activeTab === "state") {
    if (!lastState?.present) { detailEl.replaceChildren(emptyDiv("No state snapshot yet.")); return; }
    detailEl.replaceChildren(buildTree(lastState.value, q, 1, "state"));
    return;
  }
  if (!selected) {
    detailEl.replaceChildren(emptyDiv("Select an action to see its " + activeTab + "."));
    return;
  }
  if (activeTab === "action") {
    detailEl.replaceChildren(buildTree({ type: selected.type, payload: selected.payload }, q, 3, "action"));
  } else {
    detailEl.replaceChildren(buildDiffTree(selected.diff, q));
  }
}

// ── Collapsible, search-aware JSON tree (Action + State) ─────────────────

function buildTree(value, q, expandDepth, tab) {
  const root = document.createElement("div");
  root.className = "tree";
  const node = renderNode(null, value, 0, q, expandDepth, tab + ":", "");
  if (!node) { root.appendChild(emptyDiv("No keys/values match the search.")); return root; }
  root.appendChild(node);
  return root;
}

function renderNode(keyStr, value, depth, q, expandDepth, tab, path) {
  if (!isObj(value)) return makeLeaf(keyStr, value, q);

  const isArr = Array.isArray(value);
  const entries = isArr ? value.map((v, i) => [String(i), v]) : Object.entries(value);
  const keyMatch = !!q && keyStr !== null && keyStr.toLowerCase().includes(q);

  const childWrap = document.createElement("div");
  childWrap.className = "tchildren";
  let anyChild = false;
  for (const [k, v] of entries) {
    const childPath = path === "" ? k : `${path}.${k}`;
    const child = renderNode(k, v, depth + 1, q, expandDepth, tab, childPath);
    if (child) { childWrap.appendChild(child); anyChild = true; }
  }
  if (q && !keyMatch && !anyChild) return null;

  const stateKey = tab + path;
  const expanded = q ? anyChild : (expandState.has(stateKey) ? expandState.get(stateKey) : depth < expandDepth);
  return container(keyStr, isArr, entries.length, childWrap, expanded, keyMatch, (next) => expandState.set(stateKey, next));
}

/** Build a collapsible container row + its (pre-rendered) children wrapper. */
function container(keyStr, isArr, count, childWrap, expanded, keyMatch, onToggle) {
  const node = document.createElement("div");
  node.className = "tnode";
  const row = document.createElement("div");
  row.className = "trow";
  const toggle = document.createElement("span");
  toggle.className = "ttoggle";
  toggle.textContent = count === 0 ? "" : expanded ? "▼" : "▶";
  row.appendChild(toggle);
  if (keyStr !== null) {
    const k = document.createElement("span");
    k.className = "tkey" + (keyMatch ? " thit" : "");
    k.textContent = keyStr;
    row.appendChild(k);
    row.appendChild(span("tcolon", ":"));
  }
  row.appendChild(span("tsummary", isArr ? `[ ${count} ]` : `{ ${count} }`));
  node.appendChild(row);
  childWrap.style.display = expanded ? "" : "none";
  node.appendChild(childWrap);
  if (count > 0) {
    const fn = () => {
      const nowHidden = childWrap.style.display === "none";
      childWrap.style.display = nowHidden ? "" : "none";
      toggle.textContent = nowHidden ? "▼" : "▶";
      onToggle(nowHidden);
    };
    toggle.addEventListener("click", fn);
    row.querySelector(".tsummary").addEventListener("click", fn);
    const keyEl = row.querySelector(".tkey");
    if (keyEl) keyEl.addEventListener("click", fn);
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
  row.appendChild(span("ttoggle", ""));
  if (keyStr !== null) {
    const k = document.createElement("span");
    k.className = "tkey" + (keyMatch ? " thit" : "");
    k.textContent = keyStr;
    row.appendChild(k);
    row.appendChild(span("tcolon", ":"));
  }
  const v = document.createElement("span");
  v.className = info.cls + (valMatch ? " thit" : "");
  v.textContent = info.text;
  row.appendChild(v);
  node.appendChild(row);
  return node;
}

// ── Unified diff tree (Diff tab) — old↦new, changed leaves only ──────────

function buildDiffTree(entries, q) {
  const root = document.createElement("div");
  root.className = "tree";
  if (!Array.isArray(entries) || entries.length === 0) {
    root.appendChild(emptyDiv("No state changes for this action."));
    return root;
  }
  let any = false;
  for (const e of entries) {
    if (!e || typeof e !== "object") continue;
    const key = String(e.path ?? "?");
    const op = e.op === "add" || e.op === "remove" ? e.op : "replace";
    const node = renderDiff(key, e.before, e.after, op, 0, q, "diff:" + key);
    if (node) { root.appendChild(node); any = true; }
  }
  if (!any) root.appendChild(emptyDiv(q ? "No changes match the search." : "No changes."));
  return root;
}

function renderDiff(keyStr, before, after, op, depth, q, path) {
  const keyMatch = !!q && keyStr.toLowerCase().includes(q);

  // Recurse when both sides are plain objects (drill into nested changes).
  if (op === "replace" && isObj(before) && isObj(after) && !Array.isArray(before) && !Array.isArray(after)) {
    const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])];
    const childWrap = document.createElement("div");
    childWrap.className = "tchildren";
    let anyChild = false;
    for (const k of keys) {
      const inB = k in before, inA = k in after;
      if (inB && inA && hashData(before[k]) === hashData(after[k])) continue; // unchanged → omit
      const childOp = inB ? (inA ? "replace" : "remove") : "add";
      const child = renderDiff(k, before[k], after[k], childOp, depth + 1, q, `${path}.${k}`);
      if (child) { childWrap.appendChild(child); anyChild = true; }
    }
    if (!anyChild && !keyMatch) return q ? null : null; // nothing changed under here
    const expanded = q ? true : (expandState.has(path) ? expandState.get(path) : true);
    return container(keyStr, false, childWrap.childElementCount, childWrap, expanded, keyMatch, (n) => expandState.set(path, n));
  }

  // Leaf-level change (or add / remove / type change).
  return diffLeaf(keyStr, before, after, op, q, keyMatch);
}

function diffLeaf(keyStr, before, after, op, q, keyMatch) {
  const bText = reprShort(before);
  const aText = reprShort(after);
  if (q && !keyMatch && !bText.toLowerCase().includes(q) && !aText.toLowerCase().includes(q)) return null;

  const node = document.createElement("div");
  node.className = "tnode";
  const row = document.createElement("div");
  row.className = "trow trow-diff";
  row.appendChild(span("ttoggle", op === "add" ? "+" : op === "remove" ? "−" : "~"));
  const k = document.createElement("span");
  k.className = "tkey" + (keyMatch ? " thit" : "");
  k.textContent = keyStr;
  row.appendChild(k);
  row.appendChild(span("tcolon", ":"));

  if (op === "remove") {
    row.appendChild(valSpan(before, "tdel"));
  } else if (op === "add") {
    row.appendChild(valSpan(after, "tadd"));
  } else {
    row.appendChild(valSpan(before, "tdel"));
    row.appendChild(span("tarrow", " → "));
    row.appendChild(valSpan(after, "tadd"));
  }
  node.appendChild(row);
  return node;
}

/** A value span: primitive via leafInfo styling, object/array as a short repr,
 *  with an optional change class (tdel = old/strike, tadd = new). */
function valSpan(value, changeCls) {
  const s = document.createElement("span");
  if (isObj(value)) {
    s.className = "tsummary " + changeCls;
    s.textContent = Array.isArray(value) ? `[ ${value.length} ]` : `{ ${Object.keys(value).length} }`;
  } else {
    const info = leafInfo(value);
    s.className = info.cls + " " + changeCls;
    s.textContent = info.text;
  }
  return s;
}

function reprShort(v) {
  if (v === undefined) return "";
  if (isObj(v)) return Array.isArray(v) ? `[${v.length}]` : `{${Object.keys(v).length}}`;
  return leafInfo(v).text;
}

// ── leaf formatting ───────────────────────────────────────────────────────

function leafInfo(value) {
  if (value === null) return { cls: "tnull", text: "null" };
  if (value === undefined) return { cls: "tnull", text: "undefined" };
  if (typeof value === "number") return { cls: "tnumber", text: String(value) };
  if (typeof value === "boolean") return { cls: "tbool", text: String(value) };
  if (typeof value === "string") {
    if (value === "[redacted]") return { cls: "tredacted", text: "[redacted]" };
    if (/^<.+>$/.test(value)) return { cls: "ttype", text: value };
    return { cls: "tstring", text: JSON.stringify(value) };
  }
  return { cls: "tstring", text: String(value) };
}

// ── small DOM helpers ────────────────────────────────────────────────────

function span(cls, text) { const s = document.createElement("span"); s.className = cls; s.textContent = text; return s; }
function cell(cls, text) { const td = document.createElement("td"); td.className = cls; td.textContent = text; return td; }
function label(text) { return span("status-label", text + " "); }
function value(text, cls = "status-value") { return span(cls, text); }
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
if (detailSearchEl) detailSearchEl.addEventListener("input", () => renderDetail({ force: true }));
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
