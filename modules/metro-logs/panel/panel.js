// Panel client for metro-logs. Runs in an isolated WebContentsView
// spawned by the rn-dev panel-bridge — the preload exposes `window.rnDev`
// with `callTool(tool, args?)` for invoking this module's own subprocess
// tools.
//
// Uses DOM-builder APIs (no innerHTML) so log lines containing rogue HTML
// don't get rendered — Metro output is untrusted.

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
const streamEl = /** @type {HTMLSelectElement} */ (document.getElementById("stream"));
const followEl = /** @type {HTMLInputElement} */ (document.getElementById("follow"));
const filterCountEl = document.getElementById("filter-count");

const POLL_INTERVAL_MS = 1000;
const MAX_ROWS = 500;
let pollTimer = null;
let inFlight = false;
let lastError = null;
let cursor = null;
const rows = [];

// ── Hybrid chip filter (vendored from modules/redux/panel/panel.js) ──────
// Keep in sync with redux. If a 4th panel needs this, extract to a shared
// file (panels are loaded by Electron file:// from their own module dir, so
// cross-module imports don't work — vendoring is the v1 story).

function el(tag, cls) { const e = document.createElement(tag); if (cls) e.className = cls; return e; }

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
  segInc.addEventListener("mousedown", (e) => e.preventDefault());
  segExc.addEventListener("mousedown", (e) => e.preventDefault());
  segInc.addEventListener("click", () => setMode("include"));
  segExc.addEventListener("click", () => setMode("exclude"));
  renderSeg();

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
    if (v.startsWith("-")) { m = "exclude"; v = v.slice(1).trim(); }
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

// Suggestions: short distinctive tokens harvested from recent log lines.
// Bracketed tags ([Metro], [BUILD]…) bubble first, then 3-30 char word
// tokens. Dedup, cap at 200 — chip filter slices further by query.
function lineSuggestions() {
  const tags = new Set();
  const words = new Set();
  for (const e of rows) {
    const line = e?.line ?? "";
    if (!line) continue;
    for (const m of line.matchAll(/\[[^\]\s]{1,40}\]/g)) tags.add(m[0]);
    for (const m of line.matchAll(/[A-Za-z_][A-Za-z0-9_-]{2,29}/g)) {
      if (words.size >= 400) break;
      words.add(m[0]);
    }
  }
  return [...tags, ...words].slice(0, 200);
}

const filter = createChipFilter(document.getElementById("filter"), {
  placeholder: "filter log lines… (type, Tab to add, '-foo' to exclude)",
  getSuggestions: lineSuggestions,
  onChange: () => render(),
});

async function refresh({ force = false } = {}) {
  if (!rnDev || typeof rnDev.callTool !== "function") {
    renderFatal("Panel preload unavailable — open the Metro Logs panel from the sidebar.");
    return;
  }
  if (inFlight && !force) return;
  inFlight = true;
  try {
    const listArgs = {};
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
  const matched = filter.active ? rows.filter((e) => filter.test(e.line ?? "")) : rows;
  filterCountEl.textContent = filter.active ? `showing ${matched.length} of ${rows.length}` : "";

  if (matched.length === 0) {
    const empty = document.createElement("div");
    empty.className = "empty";
    empty.textContent = rows.length === 0
      ? "No captured log lines yet."
      : "No log lines match the filter.";
    contentEl.replaceChildren(empty);
    return;
  }
  const list = document.createElement("div");
  list.className = "log-list";
  for (const entry of matched) {
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
})();
