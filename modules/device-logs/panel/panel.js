// Panel client for device-logs. Runs in an isolated WebContentsView
// spawned by the rn-dev panel-bridge — the preload exposes `window.rnDev`
// with `callTool(tool, args?)` for invoking this module's own subprocess
// tools.
//
// Same UX as metro-logs (chip filter, follow-scroll, per-row copy,
// selection-safe rendering, level highlighting) — adapted to the
// device-logs data shape (per-device, level enum, structured tag).
// Vendored helpers stay in sync with modules/metro-logs/panel/panel.js.

/* global window, document, setInterval, clearInterval */

(() => {
const rnDev = /** @type {any} */ (window).rnDev;
const contentEl = document.getElementById("content");
const statusEl = document.getElementById("status");
const refreshBtn = document.getElementById("refresh");
const clearBtn = document.getElementById("clear");
const copyAllBtn = document.getElementById("copy-all");
const sourceEl = /** @type {HTMLSelectElement} */ (document.getElementById("source"));
const levelEl = /** @type {HTMLSelectElement} */ (document.getElementById("level"));
const followEl = /** @type {HTMLInputElement} */ (document.getElementById("follow"));
const filterCountEl = document.getElementById("filter-count");

// Tap controls
const tapPlatformEl = /** @type {HTMLSelectElement} */ (document.getElementById("tap-platform"));
const tapDeviceEl = /** @type {HTMLInputElement} */ (document.getElementById("tap-device"));
const tapPackageEl = /** @type {HTMLInputElement} */ (document.getElementById("tap-package"));
const tapSimulatorEl = /** @type {HTMLInputElement} */ (document.getElementById("tap-simulator"));
const tapStartBtn = document.getElementById("tap-start");
const tapActiveEl = document.getElementById("tap-active");

const POLL_INTERVAL_MS = 1000;
const MAX_ROWS = 1000;
let pollTimer = null;
let inFlight = false;
let lastError = null;
let cursor = null;
const rows = [];
let activeTaps = [];

// ── Hybrid chip filter (vendored from modules/redux/panel/panel.js) ──────

function el(tag, cls) { const e = document.createElement(tag); if (cls) e.className = cls; return e; }

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
  const segInc = el("button", "cf-seg-btn incl"); segInc.type = "button"; segInc.textContent = "Include";
  const segExc = el("button", "cf-seg-btn excl"); segExc.type = "button"; segExc.textContent = "Exclude";
  seg.append(segInc, segExc);
  const renderSeg = () => { segInc.classList.toggle("active", addMode === "include"); segExc.classList.toggle("active", addMode === "exclude"); };
  const setMode = (m) => { addMode = m; renderSeg(); input.value = ""; closeDropdown(); };
  segInc.addEventListener("mousedown", (e) => e.preventDefault());
  segExc.addEventListener("mousedown", (e) => e.preventDefault());
  segInc.addEventListener("click", () => setMode("include"));
  segExc.addEventListener("click", () => setMode("exclude"));
  renderSeg();
  const clearChipsBtn = el("button", "cf-clear");
  clearChipsBtn.type = "button"; clearChipsBtn.textContent = "clear";
  clearChipsBtn.addEventListener("mousedown", (e) => e.preventDefault());
  clearChipsBtn.addEventListener("click", () => { terms.length = 0; recompute(); renderChips(); closeDropdown(); opts.onChange(); });
  const recompute = () => {
    incM = terms.filter((t) => t.mode === "include").map((t) => makeMatcher(t.value));
    excM = terms.filter((t) => t.mode === "exclude").map((t) => makeMatcher(t.value));
  };
  const renderChips = () => {
    row.replaceChildren(seg);
    for (const t of terms) {
      const chip = el("span", "cf-chip " + (t.mode === "include" ? "inc" : "exc"));
      chip.appendChild(Object.assign(el("span"), { textContent: t.value }));
      const m = el("span", "cf-mode"); m.textContent = t.mode === "include" ? "inc" : "exc";
      m.addEventListener("click", () => { t.mode = t.mode === "include" ? "exclude" : "include"; recompute(); renderChips(); opts.onChange(); });
      chip.appendChild(m);
      const x = el("span", "cf-x"); x.textContent = "×";
      x.addEventListener("click", () => { const i = terms.indexOf(t); if (i >= 0) terms.splice(i, 1); recompute(); renderChips(); opts.onChange(); });
      chip.appendChild(x);
      row.appendChild(chip);
    }
    row.appendChild(input);
    if (terms.length) row.appendChild(clearChipsBtn);
  };
  const commit = (rawValue) => {
    let v = String(rawValue).trim(); let m = addMode;
    if (v.startsWith("-")) { m = "exclude"; v = v.slice(1).trim(); }
    if (v && !terms.some((t) => t.value === v && t.mode === m)) terms.push({ value: v, mode: m });
    input.value = ""; closeDropdown(); recompute(); renderChips(); input.focus(); opts.onChange();
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
    hi(text) { const s = String(text); return incM.some((m) => m(s)); },
    sig() { return terms.map((t) => t.mode[0] + ":" + t.value).join("|"); },
  };
}

// ── Selection + copy + per-row icon (vendored from metro-logs) ───────────

let mouseHeldInList = false;
contentEl.addEventListener("mousedown", (e) => {
  if (e.target && /** @type {Element} */ (e.target).closest?.(".log-list")) {
    mouseHeldInList = true;
  }
}, { passive: true });
document.addEventListener("mouseup", () => { mouseHeldInList = false; }, { passive: true });

function userIsInteractingWithList() {
  if (mouseHeldInList) return true;
  const list = contentEl.querySelector(".log-list");
  if (!list) return false;
  const sel = document.getSelection();
  if (!sel || sel.isCollapsed) return false;
  return list.contains(sel.anchorNode) || list.contains(sel.focusNode);
}

function makeCopyIcon(getText, title = "Copy line to clipboard") {
  const btn = document.createElement("span");
  btn.className = "tcopy"; btn.title = title;
  const svgNS = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(svgNS, "svg");
  svg.setAttribute("viewBox", "0 0 16 16"); svg.setAttribute("width", "11"); svg.setAttribute("height", "11"); svg.setAttribute("aria-hidden", "true");
  const back = document.createElementNS(svgNS, "rect");
  back.setAttribute("x", "5"); back.setAttribute("y", "2"); back.setAttribute("width", "9"); back.setAttribute("height", "11"); back.setAttribute("rx", "1.5");
  back.setAttribute("fill", "none"); back.setAttribute("stroke", "currentColor"); back.setAttribute("stroke-width", "1.2");
  const front = document.createElementNS(svgNS, "rect");
  front.setAttribute("x", "2"); front.setAttribute("y", "4"); front.setAttribute("width", "9"); front.setAttribute("height", "11"); front.setAttribute("rx", "1.5");
  front.setAttribute("fill", "none"); front.setAttribute("stroke", "currentColor"); front.setAttribute("stroke-width", "1.2");
  svg.appendChild(back); svg.appendChild(front); btn.appendChild(svg);
  btn.addEventListener("click", (e) => {
    e.stopPropagation();
    const text = String(getText() ?? "");
    if (navigator.clipboard?.writeText) {
      navigator.clipboard.writeText(text).then(() => {
        btn.classList.add("copied");
        setTimeout(() => btn.classList.remove("copied"), 700);
      }, () => {});
    }
  });
  return btn;
}

// ── Filter suggestions: tags + device ids + words ────────────────────────

function lineSuggestions() {
  const tags = new Set();
  const ids = new Set();
  const words = new Set();
  for (const e of rows) {
    if (e.tag) tags.add(e.tag);
    if (e.deviceId) ids.add(e.deviceId);
    const m = e.message ?? "";
    for (const w of m.matchAll(/[A-Za-z_][A-Za-z0-9_-]{2,29}/g)) {
      if (words.size >= 400) break;
      words.add(w[0]);
    }
  }
  return [...tags, ...ids, ...words].slice(0, 200);
}

const filter = createChipFilter(document.getElementById("filter"), {
  placeholder: "filter device logs… (tag, device, level — '-foo' to exclude)",
  getSuggestions: lineSuggestions,
  onChange: () => render(),
});

// ── Data fetch ───────────────────────────────────────────────────────────

async function refresh({ force = false } = {}) {
  if (!rnDev || typeof rnDev.callTool !== "function") {
    renderFatal("Panel preload unavailable — open the Device Logs panel from the sidebar.");
    return;
  }
  if (inFlight && !force) return;
  inFlight = true;
  try {
    const listArgs = {};
    if (sourceEl.value === "ios" || sourceEl.value === "android") listArgs.source = sourceEl.value;
    if (levelEl.value) listArgs.level = levelEl.value;
    if (cursor) listArgs.since = cursor;
    const reply = await rnDev.callTool("list", listArgs);
    if (reply?.kind === "error") { renderFatal(`${reply.code}: ${reply.message}`); return; }
    const result = reply?.result ?? reply;
    lastError = null;
    ingest(result);
    activeTaps = result?.meta?.taps ?? [];
    render();
    renderTapsRow();
  } catch (err) {
    renderFatal(err instanceof Error ? err.message : String(err));
  } finally {
    inFlight = false;
  }
}

function ingest(result) {
  if (!result) return;
  const entries = Array.isArray(result.entries) ? result.entries : [];
  const meta = result.meta ?? null;
  if (!cursor || result.cursorDropped) {
    rows.length = 0;
    for (const e of entries) rows.push(e);
  } else {
    for (const e of entries) rows.push(e);
    if (rows.length > MAX_ROWS) rows.splice(0, rows.length - MAX_ROWS);
  }
  if (meta) {
    cursor = { bufferEpoch: meta.bufferEpoch, sequence: meta.lastEventSequence };
    renderStatus(meta, rows.length);
  }
}

async function doClear() {
  if (!rnDev || typeof rnDev.callTool !== "function") return;
  clearBtn.disabled = true;
  try {
    await rnDev.callTool("clear", {});
    rows.length = 0; cursor = null;
    await refresh({ force: true });
  } catch (err) {
    renderFatal(err instanceof Error ? err.message : String(err));
  } finally {
    clearBtn.disabled = false;
  }
}

// ── Tap control ──────────────────────────────────────────────────────────

async function startTapFromForm() {
  const platform = tapPlatformEl.value;
  const deviceId = tapDeviceEl.value.trim();
  if (!deviceId) {
    flashTapError("device id is required");
    return;
  }
  const args = { platform, deviceId };
  const pkg = tapPackageEl.value.trim();
  if (pkg) {
    if (platform === "ios") args.bundleId = pkg;
    else args.packageName = pkg;
  }
  if (platform === "ios" && tapSimulatorEl.checked) args.simulator = true;
  try {
    const reply = await rnDev.callTool("start-tap", args);
    if (reply?.kind === "error") { flashTapError(`${reply.code}: ${reply.message}`); return; }
    const tap = reply?.result ?? reply;
    if (tap?.status === "error") flashTapError(tap.error || "tap failed");
    await refresh({ force: true });
  } catch (err) {
    flashTapError(err instanceof Error ? err.message : String(err));
  }
}

async function stopTap(tapId) {
  try {
    await rnDev.callTool("stop-tap", { tapId });
    await refresh({ force: true });
  } catch (err) {
    flashTapError(err instanceof Error ? err.message : String(err));
  }
}

function flashTapError(message) {
  const existing = document.getElementById("tap-error-banner");
  if (existing) existing.remove();
  const banner = document.createElement("div");
  banner.id = "tap-error-banner";
  banner.className = "tap-error-banner";
  banner.textContent = message;
  document.getElementById("taps").appendChild(banner);
  setTimeout(() => { banner.remove(); }, 5000);
}

function renderTapsRow() {
  tapActiveEl.replaceChildren();
  for (const tap of activeTaps) {
    const chip = el("span", `tap-chip ${tap.status === "running" ? "running" : tap.status === "error" ? "error" : ""}`);
    chip.textContent = `${tap.source}:${tap.deviceId.slice(0, 12)}${tap.deviceId.length > 12 ? "…" : ""} (${tap.status})`;
    const x = document.createElement("button");
    x.type = "button"; x.textContent = "×"; x.title = "Stop tap";
    x.addEventListener("click", () => stopTap(tap.tapId));
    chip.appendChild(x);
    tapActiveEl.appendChild(chip);
  }
}

// ── Render ───────────────────────────────────────────────────────────────

const AT_BOTTOM_SLOP = 8;
let suppressAutoToggle = 0;
function isAtBottom(elx) { return elx.scrollHeight - elx.scrollTop - elx.clientHeight <= AT_BOTTOM_SLOP; }

function render() {
  if (userIsInteractingWithList()) return;
  const matched = filter.active ? rows.filter((e) => filter.test(searchText(e))) : rows;
  filterCountEl.textContent = filter.active ? `showing ${matched.length} of ${rows.length}` : "";
  if (matched.length === 0) {
    const empty = document.createElement("div");
    empty.className = "empty";
    if (rows.length === 0) {
      empty.textContent = activeTaps.length === 0
        ? "No taps running — start one above to capture device logs."
        : "Waiting for log lines…";
    } else {
      empty.textContent = "No log lines match the filter.";
    }
    contentEl.replaceChildren(empty);
    return;
  }
  const prev = contentEl.querySelector(".log-list");
  const prevScrollTop = prev ? prev.scrollTop : 0;
  const prevAtBottom = prev ? isAtBottom(prev) : true;
  const list = document.createElement("div");
  list.className = "log-list";
  for (const entry of matched) list.appendChild(renderRow(entry));
  contentEl.replaceChildren(list);
  suppressAutoToggle++;
  if (followEl.checked || prevAtBottom) list.scrollTop = list.scrollHeight;
  else list.scrollTop = prevScrollTop;
  requestAnimationFrame(() => requestAnimationFrame(() => { suppressAutoToggle = 0; }));
  list.addEventListener("scroll", () => {
    if (suppressAutoToggle > 0) return;
    const atBottom = isAtBottom(list);
    if (atBottom && !followEl.checked) followEl.checked = true;
    else if (!atBottom && followEl.checked) followEl.checked = false;
  }, { passive: true });
}

function searchText(entry) {
  return `${entry.source} ${entry.deviceId} ${entry.tag} ${entry.level} ${entry.message}`;
}

function renderRow(entry) {
  const row = document.createElement("div");
  row.className = `log-row log-${entry.level} source-${entry.source}`;
  const seq = document.createElement("span"); seq.className = "seq"; seq.textContent = `#${entry.sequence}`;
  row.appendChild(seq);
  const did = document.createElement("span"); did.className = "device-id-cell";
  did.textContent = entry.deviceId ? entry.deviceId.slice(0, 8) : "";
  did.title = entry.deviceId || "";
  row.appendChild(did);
  if (entry.tag) {
    const tag = document.createElement("span");
    tag.className = "seq"; tag.textContent = `[${entry.tag.slice(0, 30)}]`;
    tag.title = entry.tag;
    row.appendChild(tag);
  }
  const text = document.createElement("span"); text.className = "log-text"; text.textContent = entry.message ?? "";
  row.appendChild(text);
  row.appendChild(makeCopyIcon(() => entry.message ?? ""));
  return row;
}

function renderFatal(message) {
  lastError = message;
  statusEl.hidden = true;
  const div = document.createElement("div");
  div.className = "error"; div.textContent = message;
  contentEl.replaceChildren(div);
}

function renderStatus(meta, entryCount) {
  if (!meta) { statusEl.hidden = true; return; }
  const tapCount = Array.isArray(meta.taps) ? meta.taps.length : 0;
  const runningCount = Array.isArray(meta.taps) ? meta.taps.filter((t) => t.status === "running").length : 0;
  const children = [
    labelSpan("Taps:"),
    valueSpan(`${runningCount}/${tapCount}`, tapCount === 0 ? "status-value status-value--muted" : "status-value status-value--ok"),
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

function labelSpan(text) { const span = document.createElement("span"); span.className = "status-label"; span.textContent = text; return span; }
function valueSpan(text, cls = "status-value") { const span = document.createElement("span"); span.className = cls; span.textContent = text; return span; }

function startPolling() {
  stopPolling();
  pollTimer = setInterval(() => { if (lastError) return; refresh(); }, POLL_INTERVAL_MS);
}
function stopPolling() { if (pollTimer !== null) { clearInterval(pollTimer); pollTimer = null; } }

// ── Wiring ───────────────────────────────────────────────────────────────

refreshBtn.addEventListener("click", () => { cursor = null; rows.length = 0; refresh({ force: true }); });
clearBtn.addEventListener("click", doClear);
copyAllBtn.addEventListener("click", () => {
  const matched = filter.active ? rows.filter((e) => filter.test(searchText(e))) : rows;
  const text = matched.map((e) => `[${e.level}] ${e.tag} ${e.message ?? ""}`.trim()).join("\n");
  if (navigator.clipboard?.writeText) {
    navigator.clipboard.writeText(text).then(() => {
      const original = copyAllBtn.textContent;
      copyAllBtn.classList.add("copied");
      copyAllBtn.textContent = `Copied ${matched.length}`;
      setTimeout(() => { copyAllBtn.classList.remove("copied"); copyAllBtn.textContent = original; }, 1100);
    }, () => {});
  }
});
sourceEl.addEventListener("change", () => { cursor = null; rows.length = 0; refresh({ force: true }); });
levelEl.addEventListener("change", () => { cursor = null; rows.length = 0; refresh({ force: true }); });
followEl.addEventListener("change", () => {
  if (followEl.checked) {
    const list = contentEl.querySelector(".log-list");
    if (list) {
      suppressAutoToggle++;
      list.scrollTop = list.scrollHeight;
      requestAnimationFrame(() => requestAnimationFrame(() => { suppressAutoToggle = 0; }));
    }
  }
});
tapStartBtn.addEventListener("click", () => void startTapFromForm());
tapPlatformEl.addEventListener("change", () => {
  const isAndroid = tapPlatformEl.value === "android";
  tapSimulatorEl.disabled = isAndroid;
  if (isAndroid) tapSimulatorEl.checked = false;
});

document.addEventListener("visibilitychange", () => {
  if (document.hidden) stopPolling();
  else { refresh({ force: true }); startPolling(); }
});

refresh({ force: true });
startPolling();
})();
