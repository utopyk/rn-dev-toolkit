// Panel client for redux. Runs in an isolated WebContentsView spawned by
// the rn-dev panel-bridge; `window.rnDev.callTool(tool, args?)` invokes
// this module's own subprocess tools (short names — the bridge prepends
// the module id).
//
// Layout (react-native-debugger style): left = action list; right =
// Action / State / Diff tabs over a collapsible, filterable JSON tree.
// Both filters are hybrid chip filters: type with autocomplete, committed
// terms become include/exclude chips. Semantics: excludes always win,
// multiple includes = OR, no includes = everything. `*` is a glob.
// "Reveal values" requests `mode:"full"` (real values; host blacklist still
// masks secrets); off = structure-only. Diff is a unified old→new view.

/* global window, document, setInterval, clearInterval, Date */

// IIFE wrap — see panel-rnDev-collision: a top-level `const rnDev` collides
// with the non-configurable `window.rnDev` the preload installs.
(() => {
const rnDev = /** @type {any} */ (window).rnDev;
const statusEl = document.getElementById("status");
const actionsEl = document.getElementById("actions");
const actionCountEl = document.getElementById("action-count");
const detailEl = document.getElementById("detail");
const refreshBtn = document.getElementById("refresh");
const clearBtn = document.getElementById("clear");
const revealEl = /** @type {any} */ (document.getElementById("reveal"));
const tabsEl = document.getElementById("tabs");

const POLL_INTERVAL_MS = 2000;
let pollTimer = null;
let inFlight = false;
let lastError = null;
let selectedSeq = null;
let activeTab = "state"; // "action" | "state" | "diff"
let lastActions = [];
let lastState = { present: false, value: undefined };
const expandState = new Map(); // `${tab}:${path}` → bool (persist across polls)
let lastDetailSig = "";

function mode() { return revealEl && revealEl.checked ? "full" : "mcp-redacted"; }
function isObj(v) { return v !== null && typeof v === "object"; }
function hashData(v) { try { return JSON.stringify(v) ?? "u"; } catch { return "x"; } }
function el(tag, cls) { const e = document.createElement(tag); if (cls) e.className = cls; return e; }

// ── Hybrid chip filter (autocomplete input + include/exclude chips) ───────

/** `*` ⇒ anchored glob, else case-insensitive substring. */
function makeMatcher(term) {
  const t = String(term).toLowerCase();
  if (t.includes("*")) {
    const re = new RegExp("^" + t.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*") + "$", "i");
    return (s) => re.test(String(s));
  }
  return (s) => String(s).toLowerCase().includes(t);
}

function createChipFilter(container, opts) {
  const terms = []; // { value, mode: "include" | "exclude" }
  let incM = [];
  let excM = [];
  let sugItems = [];
  let sugIndex = -1;

  container.classList.add("cf");
  const row = el("div", "cf-row");
  const input = document.createElement("input");
  input.className = "cf-input";
  input.placeholder = opts.placeholder || "";
  const dropdown = el("div", "cf-dropdown");
  dropdown.hidden = true;
  container.replaceChildren(row, dropdown);

  // Add-mode segmented toggle: governs whether newly committed terms are
  // included or excluded. Rendered as a 2-segment switch (both options
  // visible, the active one highlighted) so it reads as a control, not a chip.
  // A leading "-" on a typed term also forces exclude.
  let addMode = "include";
  const seg = el("div", "cf-seg");
  const segInc = el("button", "cf-seg-btn incl");
  segInc.type = "button"; segInc.textContent = "Include";
  const segExc = el("button", "cf-seg-btn excl");
  segExc.type = "button"; segExc.textContent = "Exclude";
  seg.title = "Add new terms as include or exclude (or prefix a term with '-' to exclude)";
  seg.append(segInc, segExc);
  const renderSeg = () => {
    segInc.classList.toggle("active", addMode === "include");
    segExc.classList.toggle("active", addMode === "exclude");
  };
  const setMode = (m) => { addMode = m; renderSeg(); input.value = ""; closeDropdown(); };
  // preventDefault on mousedown keeps focus on the input instead of moving it
  // to the button — without it the input blurs then refocuses, and the
  // focus-handler reopens the dropdown, so it flashes closed→open. With it,
  // toggling just closes the dropdown cleanly (the input stays ready to type).
  segInc.addEventListener("mousedown", (e) => e.preventDefault());
  segExc.addEventListener("mousedown", (e) => e.preventDefault());
  segInc.addEventListener("click", () => setMode("include"));
  segExc.addEventListener("click", () => setMode("exclude"));
  renderSeg();

  // Clear-all: wipe every term in one click (shown only when terms exist).
  const clearBtn = el("button", "cf-clear");
  clearBtn.type = "button"; clearBtn.textContent = "clear"; clearBtn.title = "Clear all filter terms";
  clearBtn.addEventListener("mousedown", (e) => e.preventDefault());
  clearBtn.addEventListener("click", () => { terms.length = 0; recompute(); renderChips(); closeDropdown(); opts.onChange(); });

  const recompute = () => {
    incM = terms.filter((t) => t.mode === "include").map((t) => makeMatcher(t.value));
    excM = terms.filter((t) => t.mode === "exclude").map((t) => makeMatcher(t.value));
  };
  const renderChips = () => {
    row.replaceChildren(seg);
    for (const t of terms) {
      const chip = el("span", "cf-chip " + (t.mode === "include" ? "inc" : "exc"));
      chip.appendChild(Object.assign(el("span"), { textContent: t.value }));
      const m = el("span", "cf-mode");
      m.textContent = t.mode === "include" ? "inc" : "exc";
      m.title = "Toggle include / exclude";
      m.addEventListener("click", () => { t.mode = t.mode === "include" ? "exclude" : "include"; recompute(); renderChips(); opts.onChange(); });
      chip.appendChild(m);
      const x = el("span", "cf-x");
      x.textContent = "×";
      x.title = "Remove";
      x.addEventListener("click", () => { const i = terms.indexOf(t); if (i >= 0) terms.splice(i, 1); recompute(); renderChips(); opts.onChange(); });
      chip.appendChild(x);
      row.appendChild(chip);
    }
    row.appendChild(input);
    if (terms.length) row.appendChild(clearBtn);
  };
  const commit = (rawValue) => {
    let v = String(rawValue).trim();
    let m = addMode;
    if (v.startsWith("-")) { m = "exclude"; v = v.slice(1).trim(); } // "-foo" forces exclude
    if (v && !terms.some((t) => t.value === v && t.mode === m)) terms.push({ value: v, mode: m });
    input.value = "";
    closeDropdown();
    recompute();
    renderChips();
    input.focus();
    opts.onChange();
  };
  const closeDropdown = () => { dropdown.hidden = true; sugItems = []; sugIndex = -1; };
  const openDropdown = () => {
    const q = input.value.trim().toLowerCase();
    const taken = new Set(terms.map((t) => t.value.toLowerCase()));
    const all = (opts.getSuggestions ? opts.getSuggestions() : []) || [];
    sugItems = all.filter((s) => !taken.has(String(s).toLowerCase()) && (q === "" || String(s).toLowerCase().includes(q))).slice(0, 60);
    if (sugItems.length === 0) { closeDropdown(); return; }
    sugIndex = q ? 0 : -1;
    dropdown.replaceChildren();
    sugItems.forEach((s, i) => {
      const d = el("div", "cf-sug" + (i === sugIndex ? " active" : ""));
      d.textContent = s;
      d.addEventListener("mousedown", (e) => { e.preventDefault(); commit(s); });
      dropdown.appendChild(d);
    });
    dropdown.hidden = false;
  };
  const move = (i) => { sugIndex = i; [...dropdown.children].forEach((c, idx) => c.classList.toggle("active", idx === sugIndex)); };

  input.addEventListener("input", openDropdown);
  input.addEventListener("focus", openDropdown);
  input.addEventListener("blur", () => setTimeout(closeDropdown, 130));
  input.addEventListener("keydown", (e) => {
    if (e.key === "ArrowDown") { e.preventDefault(); if (sugItems.length) move(Math.min(sugIndex + 1, sugItems.length - 1)); }
    else if (e.key === "ArrowUp") { e.preventDefault(); if (sugItems.length) move(Math.max(sugIndex - 1, 0)); }
    else if (e.key === "Tab") { if (!dropdown.hidden && sugItems.length) { e.preventDefault(); commit(sugItems[Math.max(sugIndex, 0)]); } }
    else if (e.key === "Enter") { e.preventDefault(); if (!dropdown.hidden && sugIndex >= 0) commit(sugItems[sugIndex]); else if (input.value.trim()) commit(input.value); }
    else if (e.key === "Escape") { closeDropdown(); }
    else if (e.key === "Backspace" && input.value === "" && terms.length) { terms.pop(); recompute(); renderChips(); opts.onChange(); }
  });
  renderChips();

  return {
    get active() { return terms.length > 0; },
    get hasInc() { return incM.length > 0; },
    test(text) { const s = String(text); if (excM.some((m) => m(s))) return false; if (!incM.length) return true; return incM.some((m) => m(s)); },
    excluded(text) { const s = String(text); return excM.some((m) => m(s)); },
    included(text) { const s = String(text); return incM.some((m) => m(s)); },
    hi(text) { const s = String(text); return incM.some((m) => m(s)); },
    sig() { return terms.map((t) => t.mode[0] + ":" + t.value).join("|"); },
  };
}

// suggestion sources
function actionTypeSuggestions() {
  return [...new Set(lastActions.map((a) => a.type).filter((t) => typeof t === "string"))];
}
function keySuggestions() {
  const out = new Set();
  const walk = (v, d) => { if (out.size > 300 || d > 6 || !isObj(v)) return; for (const k of Object.keys(v)) { out.add(k); walk(v[k], d + 1); } };
  if (lastState?.present) walk(lastState.value, 0);
  const sel = selectedSeq !== null ? lastActions.find((a) => a.sequence === selectedSeq) : null;
  if (sel) { walk(sel.payload, 0); if (Array.isArray(sel.diff)) for (const e of sel.diff) { walk(e?.before, 0); walk(e?.after, 0); } }
  return [...out];
}

const actionFilter = createChipFilter(document.getElementById("action-filter"), {
  placeholder: "filter actions… (type, Tab to add)",
  getSuggestions: actionTypeSuggestions,
  onChange: () => renderActions(),
});
const detailFilter = createChipFilter(document.getElementById("detail-filter"), {
  placeholder: "filter keys / values…",
  getSuggestions: keySuggestions,
  onChange: () => renderDetail({ force: true }),
});

// ── data + render orchestration ──────────────────────────────────────────

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
    renderDetail({ force });
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
  const div = el("div", "error");
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
  const matched = lastActions.filter((a) => actionFilter.test(a.type ?? ""));
  actionCountEl.textContent = actionFilter.active ? `showing ${matched.length} of ${lastActions.length}` : "";
  if (matched.length === 0) {
    actionsEl.replaceChildren(emptyDiv(lastActions.length === 0 ? "No actions captured yet." : "No actions match the filter."));
    return;
  }
  const table = document.createElement("table");
  const tbody = document.createElement("tbody");
  for (const a of [...matched].reverse()) { // newest first
    const tr = document.createElement("tr");
    tr.className = "action-row" + (a.sequence === selectedSeq ? " selected" : "");
    tr.appendChild(cell("col-seq", String(a.sequence)));
    const typeCell = cell("col-type", a.type ?? "?");
    if (actionFilter.hi(a.type ?? "")) typeCell.classList.add("thit");
    tr.appendChild(typeCell);
    tr.appendChild(cell("col-time", formatTime(a.at)));
    tr.addEventListener("click", () => {
      // Selecting an action NEVER changes the active tab.
      selectedSeq = selectedSeq === a.sequence ? null : a.sequence;
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
  for (const btn of tabsEl.querySelectorAll(".tab")) btn.classList.toggle("active", btn.getAttribute("data-tab") === tab);
  if (!silent) renderDetail({ force: true });
}

// ── detail (signature-gated to survive polling) ──────────────────────────

function detailSignature() {
  const f = detailFilter.sig();
  const sel = selectedSeq;
  const a = sel !== null ? lastActions.find((x) => x.sequence === sel) : null;
  if (activeTab === "state") return "state|" + f + "|" + (lastState?.present ? hashData(lastState.value) : "none");
  if (!a) return activeTab + "|" + f + "|none";
  if (activeTab === "action") return "action|" + f + "|" + sel + "|" + hashData({ type: a.type, payload: a.payload });
  return "diff|" + f + "|" + sel + "|" + hashData(a.diff);
}

function renderDetail({ force = false } = {}) {
  const sig = detailSignature();
  if (!force && sig === lastDetailSig) return; // unchanged ⇒ leave DOM (preserves expansion, no flicker)
  lastDetailSig = sig;
  const selected = selectedSeq !== null ? lastActions.find((a) => a.sequence === selectedSeq) : null;

  if (activeTab === "state") {
    if (!lastState?.present) { detailEl.replaceChildren(emptyDiv("No state snapshot yet.")); return; }
    detailEl.replaceChildren(buildTree(lastState.value, 1, "state"));
    return;
  }
  if (!selected) { detailEl.replaceChildren(emptyDiv("Select an action to see its " + activeTab + ".")); return; }
  if (activeTab === "action") detailEl.replaceChildren(buildTree({ type: selected.type, payload: selected.payload }, 3, "action"));
  else detailEl.replaceChildren(buildDiffTree(selected.diff));
}

// ── collapsible, filterable JSON tree (Action + State) ───────────────────

function buildTree(value, expandDepth, tab) {
  const root = el("div", "tree");
  const node = renderNode(null, value, 0, expandDepth, tab + ":", "", false);
  if (!node) { root.appendChild(emptyDiv("Nothing matches the filter.")); return root; }
  root.appendChild(node);
  return root;
}

function renderNode(keyStr, value, depth, expandDepth, tab, path, ancInc) {
  const f = detailFilter;
  if (!isObj(value)) return makeLeaf(keyStr, value, ancInc);

  if (f.active && keyStr !== null && f.excluded(keyStr)) return null; // excluded subtree
  const thisInc = f.hasInc && keyStr !== null && f.included(keyStr);
  const childAnc = ancInc || thisInc;

  const isArr = Array.isArray(value);
  const entries = isArr ? value.map((v, i) => [String(i), v]) : Object.entries(value);
  const childWrap = el("div", "tchildren");
  let anyChild = false;
  for (const [k, v] of entries) {
    const childPath = path === "" ? k : `${path}.${k}`;
    const child = renderNode(k, v, depth + 1, expandDepth, tab, childPath, childAnc);
    if (child) { childWrap.appendChild(child); anyChild = true; }
  }
  if (f.active && !anyChild && !thisInc && !ancInc) return null;

  const keyMatch = keyStr !== null && f.hi(keyStr);
  const stateKey = tab + path;
  const expanded = f.active ? true : (expandState.has(stateKey) ? expandState.get(stateKey) : depth < expandDepth);
  return container(keyStr, isArr, entries.length, childWrap, expanded, keyMatch, (next) => expandState.set(stateKey, next));
}

function container(keyStr, isArr, count, childWrap, expanded, keyMatch, onToggle) {
  const node = el("div", "tnode");
  const row = el("div", "trow");
  const toggle = el("span", "ttoggle");
  toggle.textContent = count === 0 ? "" : expanded ? "▼" : "▶";
  row.appendChild(toggle);
  if (keyStr !== null) {
    const k = el("span", "tkey" + (keyMatch ? " thit" : ""));
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
      const hidden = childWrap.style.display === "none";
      childWrap.style.display = hidden ? "" : "none";
      toggle.textContent = hidden ? "▼" : "▶";
      onToggle(hidden);
    };
    toggle.addEventListener("click", fn);
    row.querySelector(".tsummary").addEventListener("click", fn);
    const keyEl = row.querySelector(".tkey");
    if (keyEl) keyEl.addEventListener("click", fn);
  }
  return node;
}

function makeLeaf(keyStr, value, ancInc) {
  const f = detailFilter;
  const info = leafInfo(value);
  const kText = keyStr ?? "";
  if (f.active && (f.excluded(kText) || f.excluded(info.text))) return null;
  if (f.active && f.hasInc && !ancInc && !f.included(kText) && !f.included(info.text)) return null;

  const node = el("div", "tnode");
  const row = el("div", "trow");
  row.appendChild(span("ttoggle", ""));
  if (keyStr !== null) {
    const k = el("span", "tkey" + (f.hi(kText) ? " thit" : ""));
    k.textContent = keyStr;
    row.appendChild(k);
    row.appendChild(span("tcolon", ":"));
  }
  const v = el("span", info.cls + (f.hi(info.text) ? " thit" : ""));
  v.textContent = info.text;
  row.appendChild(v);
  node.appendChild(row);
  return node;
}

// ── unified diff tree (Diff tab) — old↦new, changed leaves only ──────────

function buildDiffTree(entries) {
  const root = el("div", "tree");
  if (!Array.isArray(entries) || entries.length === 0) { root.appendChild(emptyDiv("No state changes for this action.")); return root; }
  let any = false;
  for (const e of entries) {
    if (!e || typeof e !== "object") continue;
    const key = String(e.path ?? "?");
    const op = e.op === "add" || e.op === "remove" ? e.op : "replace";
    const node = renderDiff(key, e.before, e.after, op, "diff:" + key, false);
    if (node) { root.appendChild(node); any = true; }
  }
  if (!any) root.appendChild(emptyDiv(detailFilter.active ? "No changes match the filter." : "No changes."));
  return root;
}

function renderDiff(keyStr, before, after, op, path, ancInc) {
  const f = detailFilter;
  if (f.active && f.excluded(keyStr)) return null;
  const thisInc = f.hasInc && f.included(keyStr);
  const childAnc = ancInc || thisInc;

  if (op === "replace" && isObj(before) && isObj(after) && !Array.isArray(before) && !Array.isArray(after)) {
    const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])];
    const childWrap = el("div", "tchildren");
    let anyChild = false;
    for (const k of keys) {
      const inB = k in before, inA = k in after;
      if (inB && inA && hashData(before[k]) === hashData(after[k])) continue; // unchanged
      const childOp = inB ? (inA ? "replace" : "remove") : "add";
      const child = renderDiff(k, before[k], after[k], childOp, `${path}.${k}`, childAnc);
      if (child) { childWrap.appendChild(child); anyChild = true; }
    }
    if (!anyChild && !thisInc && !ancInc && f.active) return null;
    if (!anyChild) return null; // no nested changes
    return container(keyStr, false, childWrap.childElementCount, childWrap, true, f.hi(keyStr), () => {});
  }
  return diffLeaf(keyStr, before, after, op, ancInc);
}

function diffLeaf(keyStr, before, after, op, ancInc) {
  const f = detailFilter;
  const bText = reprShort(before), aText = reprShort(after);
  if (f.active && (f.excluded(keyStr) || f.excluded(bText) || f.excluded(aText))) return null;
  if (f.active && f.hasInc && !ancInc && !f.included(keyStr) && !f.included(bText) && !f.included(aText)) return null;

  const node = el("div", "tnode");
  const row = el("div", "trow trow-diff");
  row.appendChild(span("ttoggle", op === "add" ? "+" : op === "remove" ? "−" : "~"));
  const k = el("span", "tkey" + (f.hi(keyStr) ? " thit" : ""));
  k.textContent = keyStr;
  row.appendChild(k);
  row.appendChild(span("tcolon", ":"));
  if (op === "remove") { row.appendChild(valSpan(before, "tdel")); }
  else if (op === "add") { row.appendChild(valSpan(after, "tadd")); }
  else { row.appendChild(valSpan(before, "tdel")); row.appendChild(span("tarrow", " → ")); row.appendChild(valSpan(after, "tadd")); }
  node.appendChild(row);
  return node;
}

function valSpan(value, changeCls) {
  const s = document.createElement("span");
  if (isObj(value)) { s.className = "tsummary " + changeCls; s.textContent = Array.isArray(value) ? `[ ${value.length} ]` : `{ ${Object.keys(value).length} }`; }
  else { const info = leafInfo(value); s.className = info.cls + " " + changeCls; s.textContent = info.text; }
  return s;
}
function reprShort(v) { if (v === undefined) return ""; if (isObj(v)) return Array.isArray(v) ? `[${v.length}]` : `{${Object.keys(v).length}}`; return leafInfo(v).text; }

// ── leaf formatting + small helpers ──────────────────────────────────────

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
function span(cls, text) { const s = document.createElement("span"); s.className = cls; s.textContent = text; return s; }
function cell(cls, text) { const td = document.createElement("td"); td.className = cls; td.textContent = text; return td; }
function label(text) { return span("status-label", text + " "); }
function value(text, cls = "status-value") { return span(cls, text); }
function emptyDiv(text) { const d = el("div", "empty"); d.textContent = text; return d; }
function formatTime(at) {
  if (typeof at !== "number") return "";
  const d = new Date(at);
  return d.toLocaleTimeString(undefined, { hour12: false }) + "." + String(d.getMilliseconds()).padStart(3, "0");
}

function startPolling() { stopPolling(); pollTimer = setInterval(() => { if (!lastError) refresh(); }, POLL_INTERVAL_MS); }
function stopPolling() { if (pollTimer !== null) { clearInterval(pollTimer); pollTimer = null; } }

// ── wiring ───────────────────────────────────────────────────────────────

refreshBtn.addEventListener("click", () => refresh({ force: true }));
clearBtn.addEventListener("click", doClear);
if (revealEl) revealEl.addEventListener("change", () => refresh({ force: true }));
for (const btn of tabsEl.querySelectorAll(".tab")) btn.addEventListener("click", () => setTab(btn.getAttribute("data-tab")));
document.addEventListener("visibilitychange", () => {
  if (document.hidden) stopPolling();
  else { refresh({ force: true }); startPolling(); }
});

refresh({ force: true });
startPolling();
})();
