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
const copyAllBtn = document.getElementById("copy-all");
const sourceEl = /** @type {HTMLSelectElement} */ (document.getElementById("source"));
const streamEl = /** @type {HTMLSelectElement} */ (document.getElementById("stream"));
const levelEl = /** @type {HTMLSelectElement} */ (document.getElementById("level"));
const followEl = /** @type {HTMLInputElement} */ (document.getElementById("follow"));
const filterCountEl = document.getElementById("filter-count");

// Tap controls (folded from the deleted device-logs panel)
const tapPlatformEl = /** @type {HTMLSelectElement} */ (document.getElementById("tap-platform"));
const tapDeviceEl = /** @type {HTMLInputElement} */ (document.getElementById("tap-device"));
const tapPackageEl = /** @type {HTMLInputElement} */ (document.getElementById("tap-package"));
const tapSimulatorEl = /** @type {HTMLInputElement} */ (document.getElementById("tap-simulator"));
const tapStartBtn = document.getElementById("tap-start");
const tapActiveEl = document.getElementById("tap-active");

const POLL_INTERVAL_MS = 1000;
const MAX_ROWS = 500;
let pollTimer = null;
let inFlight = false;
let lastError = null;
let cursor = null;
const rows = [];
// Parallel ring for native taps (folded device-logs). Native entries
// are tagged with source ("ios" | "android") at the host; merged with
// metro rows by timestamp at render time.
let nativeCursor = null;
const nativeRows = [];
let activeTaps = [];

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
    renderFatal("Panel preload unavailable — open the App Logs panel from the sidebar.");
    return;
  }
  if (inFlight && !force) return;
  inFlight = true;
  try {
    // Fetch metro stdout/stderr + native device logs in parallel. The
    // host serves each from its own ring; we merge by timestamp at
    // render time so the user sees one chronological stream.
    const metroArgs = {};
    if (streamEl.value === "stdout" || streamEl.value === "stderr") metroArgs.stream = streamEl.value;
    if (cursor) metroArgs.since = cursor;

    const nativeArgs = {};
    if (levelEl.value) nativeArgs.level = levelEl.value;
    if (nativeCursor) nativeArgs.since = nativeCursor;

    const [metroReply, nativeReply] = await Promise.all([
      rnDev.callTool("list", metroArgs),
      rnDev.callTool("native-list", nativeArgs).catch(() => null),
    ]);
    if (metroReply?.kind === "error") {
      renderFatal(`${metroReply.code}: ${metroReply.message}`);
      return;
    }
    const result = metroReply?.result ?? metroReply;
    lastError = null;
    ingest(result);

    if (nativeReply && nativeReply.kind !== "error") {
      ingestNative(nativeReply?.result ?? nativeReply);
    }
    render();
    renderTapsRow();
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
    // Clear both rings — the Clear button is unified now that the
    // panel shows both sources. Native clear is best-effort (the
    // device-logs side may have no taps so the call returns trivially).
    await Promise.all([
      rnDev.callTool("clear", {}),
      rnDev.callTool("native-clear", {}).catch(() => null),
    ]);
    rows.length = 0; cursor = null;
    nativeRows.length = 0; nativeCursor = null;
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

function ingestNative(result) {
  if (!result) return;
  const entries = Array.isArray(result.entries) ? result.entries : [];
  const meta = result.meta ?? null;
  if (!nativeCursor || result.cursorDropped) {
    nativeRows.length = 0;
    for (const e of entries) nativeRows.push(e);
  } else {
    for (const e of entries) nativeRows.push(e);
    if (nativeRows.length > MAX_ROWS) nativeRows.splice(0, nativeRows.length - MAX_ROWS);
  }
  if (meta) {
    nativeCursor = { bufferEpoch: meta.bufferEpoch, sequence: meta.lastEventSequence };
    activeTaps = Array.isArray(meta.taps) ? meta.taps : [];
  }
}

// ── Tap control ──────────────────────────────────────────────────────────

async function startTapFromForm() {
  const platform = tapPlatformEl.value;
  const deviceId = tapDeviceEl.value.trim();
  if (!deviceId) { flashTapError("device id is required"); return; }
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
  setTimeout(() => banner.remove(), 5000);
}

function renderTapsRow() {
  tapActiveEl.replaceChildren();
  for (const tap of activeTaps) {
    const chip = document.createElement("span");
    chip.className = `tap-chip ${tap.status === "running" ? "running" : tap.status === "error" ? "error" : ""}`;
    chip.textContent = `${tap.source}:${tap.deviceId.slice(0, 12)}${tap.deviceId.length > 12 ? "…" : ""} (${tap.status})`;
    const x = document.createElement("button");
    x.type = "button"; x.textContent = "×"; x.title = "Stop tap";
    x.addEventListener("click", () => stopTap(tap.tapId));
    chip.appendChild(x);
    tapActiveEl.appendChild(chip);
  }
}

// Per-group collapse state for stack-trace blocks. Key = header line's
// sequence (unique + monotonic). Persists across re-renders. Pruned when
// the header falls out of the ring buffer.
const collapsedTraces = new Map();

// Selection-aware render: the 1Hz poll's replaceChildren() blew away any
// active user selection, and the browser tried to repair the selection by
// extending it to the next surviving nodes — that's why selecting lines
// 250-251 ended up highlighting lines 1-251, then vanishing on the next
// poll. We now suppress the rebuild while either (a) a mouse button is
// held inside the log list, or (b) a non-collapsed selection lives inside
// the list. Status + counter updates still happen via the surrounding
// flow (renderStatus is called from ingest, independent of render).
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

// One-click copy icon (same shape as the redux panel's per-key icon).
// `getText` is a thunk so the displayed value can be evaluated lazily —
// useful when the row references a mutable entry. Click stops propagation
// so a copy press doesn't toggle a trace-group header.
function makeCopyIcon(getText, title = "Copy line to clipboard") {
  const btn = document.createElement("span");
  btn.className = "tcopy";
  btn.title = title;
  const svgNS = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(svgNS, "svg");
  svg.setAttribute("viewBox", "0 0 16 16");
  svg.setAttribute("width", "11"); svg.setAttribute("height", "11");
  svg.setAttribute("aria-hidden", "true");
  const back = document.createElementNS(svgNS, "rect");
  back.setAttribute("x", "5"); back.setAttribute("y", "2");
  back.setAttribute("width", "9"); back.setAttribute("height", "11"); back.setAttribute("rx", "1.5");
  back.setAttribute("fill", "none"); back.setAttribute("stroke", "currentColor"); back.setAttribute("stroke-width", "1.2");
  const front = document.createElementNS(svgNS, "rect");
  front.setAttribute("x", "2"); front.setAttribute("y", "4");
  front.setAttribute("width", "9"); front.setAttribute("height", "11"); front.setAttribute("rx", "1.5");
  front.setAttribute("fill", "none"); front.setAttribute("stroke", "currentColor"); front.setAttribute("stroke-width", "1.2");
  svg.appendChild(back); svg.appendChild(front);
  btn.appendChild(svg);
  btn.addEventListener("click", (e) => {
    e.stopPropagation();
    const text = String(getText() ?? "");
    if (navigator.clipboard?.writeText) {
      navigator.clipboard.writeText(text).then(() => {
        btn.classList.add("copied");
        setTimeout(() => btn.classList.remove("copied"), 700);
      }, () => { /* clipboard denied — silent */ });
    }
  });
  return btn;
}

// Follow-scroll: replaceChildren() on every 1Hz poll was resetting scrollTop
// to 0, which is why "follow off" couldn't stay at the bottom either. Two
// fixes layered together:
//   1. Capture scrollTop + wasAtBottom BEFORE rebuild, restore AFTER. So a
//      paused (follow=off) view keeps whatever position the user picked.
//   2. Auto-toggle follow based on user scroll. Scroll up → follow=off (you
//      can read history without the next poll yanking you back to bottom).
//      Scroll back to within `AT_BOTTOM_SLOP` of bottom → follow=on.
const AT_BOTTOM_SLOP = 8; // px; treat anything within this as "at the bottom"

let suppressAutoToggle = 0; // counter: ignore programmatic scroll events
function isAtBottom(el) {
  return el.scrollHeight - el.scrollTop - el.clientHeight <= AT_BOTTOM_SLOP;
}

function render() {
  if (userIsInteractingWithList()) return;

  // Build the unified display stream — metro entries + native entries
  // merged by capture-time timestamp. Each entry is tagged with `_kind`
  // so renderRow can dispatch without ambiguity.
  const sourceFilter = sourceEl.value; // "" | "metro" | "ios" | "android"
  const includeMetro = sourceFilter === "" || sourceFilter === "metro";
  const includeNative = sourceFilter === "" || sourceFilter === "ios" || sourceFilter === "android";

  let unified = [];
  if (includeMetro) {
    for (const e of rows) unified.push({ _kind: "metro", entry: e });
  }
  if (includeNative) {
    for (const e of nativeRows) {
      if (sourceFilter === "ios" && e.source !== "ios") continue;
      if (sourceFilter === "android" && e.source !== "android") continue;
      unified.push({ _kind: "native", entry: e });
    }
  }
  // Sort by capture-time millis (entry.at). Stable: keep insertion order
  // for equal timestamps so a burst stays in its arrival order.
  unified.sort((a, b) => (a.entry.at ?? 0) - (b.entry.at ?? 0));

  // Chip filter applies to a stringified form of each entry — uses the
  // line text for metro, and "tag message deviceId level" for native.
  const matched = filter.active ? unified.filter((u) => filter.test(textForFilter(u))) : unified;
  const totalUnfiltered = unified.length;
  filterCountEl.textContent = filter.active ? `showing ${matched.length} of ${totalUnfiltered}` : "";

  if (matched.length === 0) {
    const empty = document.createElement("div");
    empty.className = "empty";
    if (totalUnfiltered === 0) {
      empty.textContent = activeTaps.length === 0
        ? "No captured log lines yet. Start a native tap above to also capture iOS / Android device logs."
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

  // Prune trace-collapse state for headers that aged out of the metro ring.
  if (rows.length > 0) {
    const oldestSeq = rows[0].sequence;
    for (const seq of collapsedTraces.keys()) {
      if (seq < oldestSeq) collapsedTraces.delete(seq);
    }
  }

  const list = document.createElement("div");
  list.className = "log-list";
  // Walk + fold consecutive metro log-trace lines under their preceding
  // metro header. Native entries break the fold (they're a different
  // kind, can't be part of a JS stack frame).
  let i = 0;
  while (i < matched.length) {
    const u = matched[i];
    if (u._kind === "native") {
      list.appendChild(renderRow(u.entry));
      i++;
      continue;
    }
    const entry = u.entry;
    const level = classifyLine(entry.line ?? "");
    if (level === "trace") {
      list.appendChild(renderRow(entry));
      i++;
      continue;
    }
    const headerRow = renderRow(entry);
    const traces = [];
    let j = i + 1;
    while (j < matched.length && matched[j]._kind === "metro"
           && classifyLine(matched[j].entry.line ?? "") === "trace") {
      traces.push(matched[j].entry);
      j++;
    }
    if (traces.length === 0) {
      list.appendChild(headerRow);
      i++;
      continue;
    }
    list.appendChild(buildTraceGroup(headerRow, traces, entry.sequence));
    i = j;
  }
  contentEl.replaceChildren(list);

  // Restore scroll: follow-on (or user was already at the bottom) → snap to
  // bottom. Otherwise restore the prior scrollTop so the user's reading
  // position survives the rebuild.
  suppressAutoToggle++;
  if (followEl.checked || prevAtBottom) {
    list.scrollTop = list.scrollHeight;
  } else {
    list.scrollTop = prevScrollTop;
  }
  // Use double-rAF so the suppress flag stays set through any scroll events
  // the browser fires from the restore above. The handler resets on its own
  // when it sees the flag.
  requestAnimationFrame(() => requestAnimationFrame(() => { suppressAutoToggle = 0; }));

  list.addEventListener("scroll", () => {
    if (suppressAutoToggle > 0) return;
    const atBottom = isAtBottom(list);
    if (atBottom && !followEl.checked) followEl.checked = true;
    else if (!atBottom && followEl.checked) followEl.checked = false;
  }, { passive: true });
}

// Conservative level classifier — only flags lines whose level is signaled
// at the start (bracketed `[ERROR]`, RN-style `ERROR `, `Error:` prefix,
// emoji marker). Returns null for ordinary lines so the panel doesn't
// turn into a sea of red just because the word "error" appears mid-line.
function classifyLine(text) {
  const t = String(text);
  if (
    /^\s*\[(?:ERROR|FATAL)\]/i.test(t) ||
    /^\s*(?:ERROR|FATAL)\s/.test(t) ||
    /^\s*Error:/.test(t) ||
    /^\s*(?:❌|🛑|🚨)/.test(t)
  ) return "error";
  if (
    /^\s*\[WARN(?:ING)?\]/i.test(t) ||
    /^\s*WARN\s/.test(t) ||
    /^\s*Warning:/.test(t) ||
    /^\s*⚠️?/.test(t)
  ) return "warn";
  if (
    /^\s*\[INFO\]/i.test(t) ||
    /^\s*INFO\s/.test(t) ||
    /^\s*LOG\s/.test(t)
  ) return "info";
  if (
    /^\s*\[(?:DEBUG|VERBOSE|TRACE)\]/i.test(t) ||
    /^\s*DEBUG\s/.test(t)
  ) return "debug";
  // Stack-frame continuation lines ("    at fn (file:line:col)").
  if (/^\s{2,}at\s/.test(t)) return "trace";
  return null;
}

function buildTraceGroup(headerRow, traces, headerSeq) {
  const group = document.createElement("div");
  group.className = "trace-group";
  const collapsed = collapsedTraces.has(headerSeq) ? collapsedTraces.get(headerSeq) : true;

  const pill = document.createElement("button");
  pill.type = "button";
  pill.className = "trace-pill";
  const label = (col) => `${col ? "▶" : "▼"} ${traces.length} stack frame${traces.length === 1 ? "" : "s"}`;
  pill.textContent = label(collapsed);

  const children = document.createElement("div");
  children.className = "trace-children";
  children.style.display = collapsed ? "none" : "";
  for (const t of traces) children.appendChild(renderRow(t));

  const toggle = (e) => {
    if (e) e.stopPropagation();
    const isHidden = children.style.display === "none";
    children.style.display = isHidden ? "" : "none";
    pill.textContent = label(!isHidden);
    collapsedTraces.set(headerSeq, !isHidden);
  };
  pill.addEventListener("click", toggle);
  // Slot the pill BEFORE the per-row copy icon so the right edge of the
  // row stays: …text [pill] [copy].
  const copyEl = headerRow.querySelector(".tcopy");
  if (copyEl) headerRow.insertBefore(pill, copyEl);
  else headerRow.appendChild(pill);
  headerRow.classList.add("trace-header");
  headerRow.addEventListener("click", toggle);

  group.appendChild(headerRow);
  group.appendChild(children);
  return group;
}

function renderRow(entry) {
  // Native entries (folded device-logs) carry `source: "ios" | "android"`
  // and structured fields (level, tag, deviceId, message); metro entries
  // carry `stream: "stdout" | "stderr"` and a raw `line`. One renderer
  // discriminates and produces the right shape.
  if (entry.source === "ios" || entry.source === "android") {
    return renderNativeRow(entry);
  }
  return renderMetroRow(entry);
}

function renderMetroRow(entry) {
  const row = document.createElement("div");
  const level = classifyLine(entry.line ?? "");
  const streamCls = entry.stream === "stderr" ? "stderr" : "stdout";
  row.className = `log-row source-metro ${streamCls}${level ? ` log-${level}` : ""}`;

  const seq = document.createElement("span");
  seq.className = "seq";
  seq.textContent = `#${entry.sequence}`;
  row.appendChild(seq);

  const text = document.createElement("span");
  text.className = "log-text";
  text.textContent = entry.line ?? "";
  row.appendChild(text);

  row.appendChild(makeCopyIcon(() => entry.line ?? ""));
  return row;
}

function renderNativeRow(entry) {
  const row = document.createElement("div");
  row.className = `log-row source-${entry.source} log-${entry.level || "info"}`;

  const seq = document.createElement("span");
  seq.className = "seq";
  seq.textContent = `#${entry.sequence}`;
  row.appendChild(seq);

  // 8-char device-id prefix so the user can tell which device a line
  // came from when multiple taps are active.
  const did = document.createElement("span");
  did.className = "device-id-cell";
  did.textContent = entry.deviceId ? entry.deviceId.slice(0, 8) : "";
  did.title = entry.deviceId || "";
  row.appendChild(did);

  if (entry.tag) {
    const tag = document.createElement("span");
    tag.className = "seq";
    tag.textContent = `[${entry.tag.slice(0, 30)}]`;
    tag.title = entry.tag;
    row.appendChild(tag);
  }

  const text = document.createElement("span");
  text.className = "log-text";
  text.textContent = entry.message ?? "";
  row.appendChild(text);

  row.appendChild(makeCopyIcon(() => entry.message ?? ""));
  return row;
}

function textForFilter(unified) {
  if (unified._kind === "metro") return unified.entry.line ?? "";
  const e = unified.entry;
  return `${e.source} ${e.deviceId} ${e.tag} ${e.level} ${e.message ?? ""}`;
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
  cursor = null; nativeCursor = null;
  rows.length = 0; nativeRows.length = 0;
  refresh({ force: true });
});
clearBtn.addEventListener("click", doClear);
copyAllBtn.addEventListener("click", () => {
  // Copies every currently visible (post-filter) line — both metro and
  // native, in display order. Native rows get a "[ios|android] tag: …"
  // prefix so the destination can tell them apart.
  const sourceFilter = sourceEl.value;
  const includeMetro = sourceFilter === "" || sourceFilter === "metro";
  const includeNative = sourceFilter === "" || sourceFilter === "ios" || sourceFilter === "android";
  let unified = [];
  if (includeMetro) for (const e of rows) unified.push({ _kind: "metro", entry: e });
  if (includeNative) {
    for (const e of nativeRows) {
      if (sourceFilter === "ios" && e.source !== "ios") continue;
      if (sourceFilter === "android" && e.source !== "android") continue;
      unified.push({ _kind: "native", entry: e });
    }
  }
  unified.sort((a, b) => (a.entry.at ?? 0) - (b.entry.at ?? 0));
  const matched = filter.active ? unified.filter((u) => filter.test(textForFilter(u))) : unified;
  const text = matched.map((u) => {
    if (u._kind === "metro") return u.entry.line ?? "";
    const e = u.entry;
    return `[${e.source}/${e.level}] ${e.tag ? `[${e.tag}] ` : ""}${e.message ?? ""}`;
  }).join("\n");
  if (navigator.clipboard?.writeText) {
    navigator.clipboard.writeText(text).then(() => {
      const original = copyAllBtn.textContent;
      copyAllBtn.classList.add("copied");
      copyAllBtn.textContent = `Copied ${matched.length}`;
      setTimeout(() => {
        copyAllBtn.classList.remove("copied");
        copyAllBtn.textContent = original;
      }, 1100);
    }, () => { /* denied */ });
  }
});
sourceEl.addEventListener("change", () => { render(); });
levelEl.addEventListener("change", () => {
  nativeCursor = null; nativeRows.length = 0;
  refresh({ force: true });
});
streamEl.addEventListener("change", () => {
  cursor = null;
  rows.length = 0;
  refresh({ force: true });
});
tapStartBtn.addEventListener("click", () => void startTapFromForm());
tapPlatformEl.addEventListener("change", () => {
  const isAndroid = tapPlatformEl.value === "android";
  tapSimulatorEl.disabled = isAndroid;
  if (isAndroid) tapSimulatorEl.checked = false;
});
followEl.addEventListener("change", () => {
  // Manual check → snap to bottom now (next poll would too, but waiting
  // up to a second feels broken). Uncheck just stays where they are.
  if (followEl.checked) {
    const list = contentEl.querySelector(".log-list");
    if (list) {
      suppressAutoToggle++;
      list.scrollTop = list.scrollHeight;
      requestAnimationFrame(() => requestAnimationFrame(() => { suppressAutoToggle = 0; }));
    }
  }
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
