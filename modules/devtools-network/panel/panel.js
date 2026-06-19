// Panel client for devtools-network. Runs in an isolated WebContentsView
// spawned by the rn-dev panel-bridge — the preload exposes `window.rnDev`
// with `callTool(tool, args?)` for invoking this module's own subprocess
// tools.
//
// Poll cadence: 2 seconds while the panel is visible. The module's
// `list` tool returns the current ring contents; drawing is idempotent
// so we can re-render on every tick without flicker.

/* global window, document, setInterval, clearInterval, URL */

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
const filterCountEl = document.getElementById("filter-count");

const POLL_INTERVAL_MS = 2000;
let pollTimer = null;
let inFlight = false;
let lastError = null;
let lastEntries = [];
let lastMeta = null;

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
  const terms = [];
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

// Suggestions: methods (closed set), distinct hosts + path tokens from URLs,
// distinct status codes. Filter strings are matched against
// "METHOD URL STATUS" (see entrySearchText), so any of these typed in
// substring/glob form will work.
function networkSuggestions() {
  const methods = new Set();
  const hosts = new Set();
  const codes = new Set();
  for (const e of lastEntries) {
    if (e?.method) methods.add(String(e.method).toUpperCase());
    if (e?.status !== undefined && e?.status !== null) codes.add(String(e.status));
    const u = e?.url;
    if (typeof u === "string") {
      try { hosts.add(new URL(u).host); }
      catch { /* relative / malformed — ignore */ }
    }
  }
  return [...methods, ...hosts, ...codes].slice(0, 200);
}

function entrySearchText(entry) {
  // Concatenate the filterable fields so a single chip filter can match
  // any of METHOD, URL, STATUS, terminalState (`pending`/`failed`).
  const parts = [
    String(entry?.method ?? "").toUpperCase(),
    String(entry?.url ?? ""),
    String(entry?.status ?? ""),
    String(entry?.terminalState ?? ""),
  ];
  return parts.join(" ");
}

const filter = createChipFilter(document.getElementById("filter"), {
  placeholder: "filter requests… (method, host, status — Tab to add, '-foo' to exclude)",
  getSuggestions: networkSuggestions,
  onChange: () => renderEntries(),
});

async function refresh({ force = false } = {}) {
  if (!rnDev || typeof rnDev.callTool !== "function") {
    renderFatal("Panel preload unavailable — open the Network panel from the sidebar.");
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
    lastEntries = Array.isArray(result?.entries) ? result.entries : [];
    lastMeta = result?.meta ?? null;
    renderEntries();
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

function renderEntries() {
  const meta = lastMeta;
  const entries = lastEntries;
  renderStatus(meta, entries.length);

  if (entries.length === 0) {
    filterCountEl.textContent = "";
    const empty = document.createElement("div");
    empty.className = "empty";
    const refusal = captureRefusalText(meta);
    if (refusal) {
      // Connected target that ACCEPTED the socket but REFUSED the
      // capture domain — without this the panel showed "Waiting for
      // network activity…" forever with no hint (2026-06-11 acme iOS:
      // react-native-worklets registers a second RN host, so RN refuses
      // Network.enable). Tell the human why it will never fill.
      empty.className = "empty error";
      empty.textContent = refusal;
    } else {
      empty.textContent =
        meta?.proxyStatus === "connected"
          ? "Waiting for network activity…"
          : "No captures yet.";
    }
    contentEl.replaceChildren(empty);
    return;
  }

  const matched = filter.active
    ? entries.filter((e) => filter.test(entrySearchText(e)))
    : entries;
  filterCountEl.textContent = filter.active ? `showing ${matched.length} of ${entries.length}` : "";

  if (matched.length === 0) {
    const empty = document.createElement("div");
    empty.className = "empty";
    empty.textContent = "No requests match the filter.";
    contentEl.replaceChildren(empty);
    return;
  }

  // Newest last in the ring; render reversed so latest is at the top.
  const rows = [...matched].reverse();

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
  if (entry.terminalState === "pending") return "…";
  if (entry.terminalState === "failed") return "err";
  return String(entry.status ?? "");
}

function durationText(entry) {
  if (entry.terminalState === "pending") return "—";
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
  if (base.length <= max) return `${base}…`;
  return `${base.slice(0, max - 1)}…`;
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
