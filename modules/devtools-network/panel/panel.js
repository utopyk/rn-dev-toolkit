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
const listHostEl = document.getElementById("list-host");
const detailPaneEl = document.getElementById("detail-pane");
const detailHostEl = document.getElementById("detail-host");
const statusEl = document.getElementById("status");
const refreshBtn = document.getElementById("refresh");
const clearBtn = document.getElementById("clear");
const followEl = /** @type {HTMLInputElement} */ (document.getElementById("follow"));
const filterCountEl = document.getElementById("filter-count");

// Selected request — the row the user clicked. Cleared on dismiss or when
// the row falls out of the ring. The detail is fetched via the `get` tool
// (separate call so the list result can stay light + bodies show even when
// list reaped a request).
let selectedRequestId = null;
let selectedDetail = null;
let detailLoading = false;

// Follow-scroll mirror of the metro-logs panel. Newest entries render at
// the TOP here (entries reversed before render), so "follow" snaps to top
// instead of bottom. User scroll auto-toggles follow on/off — scrolling
// away from top pauses follow; scrolling back enables it.
const AT_TOP_SLOP = 8;
let suppressAutoToggle = 0;
function isAtTop(el) { return el.scrollTop <= AT_TOP_SLOP; }

// Selection-aware render — same logic as the metro-logs panel: don't
// blow away the DOM while the user has a live selection (or a held
// mouse button) inside the list or the detail body. The list rebuild
// would otherwise eat the selection mid-drag and cancel Cmd+C copies.
let mouseHeldInList = false;
let mouseHeldInDetail = false;
document.addEventListener("mousedown", (e) => {
  const t = /** @type {Element|null} */ (e.target);
  if (!t || !t.closest) return;
  if (t.closest(".table-wrap")) mouseHeldInList = true;
  if (t.closest(".det-body")) mouseHeldInDetail = true;
}, { passive: true });
document.addEventListener("mouseup", () => {
  mouseHeldInList = false;
  mouseHeldInDetail = false;
}, { passive: true });

function selectionLivesIn(rootSelector) {
  const root = document.querySelector(rootSelector);
  if (!root) return false;
  const sel = document.getSelection();
  if (!sel || sel.isCollapsed) return false;
  return root.contains(sel.anchorNode) || root.contains(sel.focusNode);
}
function userIsInteractingWithList() {
  return mouseHeldInList || selectionLivesIn(".table-wrap");
}
function userIsInteractingWithDetail() {
  return mouseHeldInDetail || selectionLivesIn(".det-body");
}

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

// Clipboard helper — copies text and pulses the calling element green
// for 700ms via the "copied" class. Returns the promise so callers can
// chain UI side-effects.
function copyToClipboard(text, btn) {
  if (!navigator.clipboard?.writeText) return Promise.resolve();
  return navigator.clipboard.writeText(String(text)).then(() => {
    if (btn) {
      btn.classList.add("copied");
      setTimeout(() => btn.classList.remove("copied"), 700);
    }
  }, () => { /* clipboard denied — silent */ });
}

function makeCopyIcon(getText, title = "Copy to clipboard") {
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
    void copyToClipboard(getText() ?? "", btn);
  });
  return btn;
}

// Build a curl command from a NetworkEntryDto. Body-quoting uses
// single-quotes; embedded single-quotes are escaped via the common
// `'\''` trick. Redacted/absent/binary bodies become a `# ...` comment
// so the user knows why the command lacks a -d arg.
function toCurl(entry) {
  const lines = [];
  const method = String(entry.method || "GET").toUpperCase();
  lines.push(`curl -X ${method} ${shellQuote(entry.url || "")}`);
  const headers = entry.requestHeaders || {};
  for (const k of Object.keys(headers).sort()) {
    lines.push(`  -H ${shellQuote(`${k}: ${headers[k]}`)}`);
  }
  const b = entry.requestBody;
  if (b && b.kind === "text" && b.data) {
    lines.push(`  --data-raw ${shellQuote(b.data)}`);
    if (b.truncated) lines.push(`  # request body truncated, ${b.droppedBytes} bytes dropped`);
  } else if (b && b.kind === "redacted") {
    lines.push(`  # request body redacted — set captureBodies: true in module config to include`);
  } else if (b && b.kind === "binary") {
    lines.push(`  # request body is ${b.mimeType || "binary"}, ${b.byteLength} bytes — not inlined`);
  }
  return lines.join(" \\\n");
}
function shellQuote(s) {
  // Single-quote everything, escape embedded single-quotes the POSIX way.
  return `'${String(s).replace(/'/g, "'\\''")}'`;
}

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
    // If the selected request transitioned (pending → finished) re-fetch
    // it so the detail pane reflects the final headers/body/timings.
    void maybeRefreshSelectedDetail();
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
  const div = document.createElement("div");
  div.className = "error";
  div.textContent = message;
  listHostEl.replaceChildren(div);
}

function renderEntries() {
  const meta = lastMeta;
  const entries = lastEntries;
  renderStatus(meta, entries.length);
  renderDetail();

  // Don't rebuild the list while the user is selecting / copying. Next
  // poll catches up.
  if (userIsInteractingWithList()) return;

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
    listHostEl.replaceChildren(empty);
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
    listHostEl.replaceChildren(empty);
    return;
  }

  // Newest last in the ring; render reversed so latest is at the top.
  const rows = [...matched].reverse();

  // Capture pre-rebuild scroll state from the existing wrapper (if any) so
  // a paused follow view keeps its position across 2 s polls.
  const prev = listHostEl.querySelector(".table-wrap");
  const prevScrollTop = prev ? prev.scrollTop : 0;
  const prevAtTop = prev ? isAtTop(prev) : true;

  const wrap = document.createElement("div");
  wrap.className = "table-wrap";
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
  wrap.appendChild(table);
  listHostEl.replaceChildren(wrap);

  suppressAutoToggle++;
  if (followEl.checked || prevAtTop) {
    wrap.scrollTop = 0;
  } else {
    wrap.scrollTop = prevScrollTop;
  }
  requestAnimationFrame(() => requestAnimationFrame(() => { suppressAutoToggle = 0; }));

  wrap.addEventListener("scroll", () => {
    if (suppressAutoToggle > 0) return;
    const atTop = isAtTop(wrap);
    if (atTop && !followEl.checked) followEl.checked = true;
    else if (!atTop && followEl.checked) followEl.checked = false;
  }, { passive: true });
}

function renderRow(entry) {
  const tr = document.createElement("tr");
  if (entry.requestId && entry.requestId === selectedRequestId) {
    tr.classList.add("selected");
  }

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
  const urlText = document.createElement("span");
  urlText.className = "col-url-text";
  urlText.textContent = truncate(entry.url || "", 160);
  url.appendChild(urlText);
  url.title = entry.url || "";
  // Per-row copy → the full URL (most-asked-for one-click action).
  url.appendChild(makeCopyIcon(() => entry.url || "", "Copy URL"));

  tr.appendChild(method);
  tr.appendChild(status);
  tr.appendChild(dur);
  tr.appendChild(url);

  tr.addEventListener("click", () => selectRequest(entry.requestId));
  return tr;
}

async function selectRequest(requestId) {
  if (!requestId) return;
  if (selectedRequestId === requestId) {
    // Re-clicking the selected row dismisses the detail pane.
    selectedRequestId = null;
    selectedDetail = null;
    detailLoading = false;
    renderEntries();
    return;
  }
  selectedRequestId = requestId;
  selectedDetail = null;
  detailLoading = true;
  renderEntries();
  try {
    const reply = await rnDev.callTool("get", { requestId });
    if (reply?.kind === "error") {
      selectedDetail = { __error: `${reply.code}: ${reply.message}` };
    } else {
      const result = reply?.result ?? reply;
      selectedDetail = result;
    }
  } catch (err) {
    selectedDetail = { __error: err instanceof Error ? err.message : String(err) };
  } finally {
    detailLoading = false;
    // Only render the detail pane, not the whole list — re-rendering the
    // list mid-poll fights with scroll restoration. Detail-only redraw is
    // safe because the list's `.selected` class is already in sync.
    renderDetail();
  }
}

function renderDetail() {
  if (!selectedRequestId) {
    detailPaneEl.hidden = true;
    detailHostEl.replaceChildren();
    return;
  }
  // If the user is actively copying inside the detail body, don't rip
  // it out from under them on the next poll.
  if (userIsInteractingWithDetail() && detailHostEl.firstChild) return;
  detailPaneEl.hidden = false;
  const head = detailHeader(selectedDetail && !selectedDetail.__error && selectedDetail.error !== "not-found" ? selectedDetail : null);
  const body = el("div", "det-body");

  if (detailLoading && !selectedDetail) {
    body.appendChild(elText("det-empty", "Loading…"));
  } else if (selectedDetail && selectedDetail.error === "not-found") {
    body.appendChild(elText("det-empty", `Request ${selectedRequestId} fell out of the buffer.`));
  } else if (selectedDetail && selectedDetail.__error) {
    body.appendChild(elText("error", selectedDetail.__error));
  } else if (!selectedDetail) {
    body.appendChild(elText("det-empty", "No data."));
  } else {
    const e = selectedDetail;
    body.appendChild(summarySection(e));
    if (e.requestHeaders) body.appendChild(headersSection("Request Headers", e.requestHeaders));
    if (e.requestBody) body.appendChild(bodySection("Request Body", e.requestBody));
    if (e.responseHeaders) body.appendChild(headersSection("Response Headers", e.responseHeaders));
    if (e.responseBody) body.appendChild(bodySection("Response Body", e.responseBody));
    if (e.initiator) body.appendChild(initiatorSection(e.initiator));
  }

  detailHostEl.replaceChildren(head, body);
}

function detailHeader(entry) {
  const head = el("div", "det-head");
  const m = el("span", "det-method");
  m.textContent = entry ? (entry.method || "").toUpperCase() : "…";
  head.appendChild(m);
  const u = el("span", "det-url");
  u.textContent = entry ? (entry.url || "") : "";
  u.title = entry ? (entry.url || "") : "";
  head.appendChild(u);
  if (entry) {
    // cURL is the killer one-click for network detail — most tools have
    // this and the user gets a re-runnable command without hand-quoting.
    const curlBtn = el("button", "det-action");
    curlBtn.type = "button"; curlBtn.textContent = "cURL"; curlBtn.title = "Copy as curl command";
    curlBtn.addEventListener("click", () => void copyToClipboard(toCurl(entry), curlBtn));
    head.appendChild(curlBtn);
    // Whole-entry JSON is the other useful bulk grab.
    const jsonBtn = el("button", "det-action");
    jsonBtn.type = "button"; jsonBtn.textContent = "JSON"; jsonBtn.title = "Copy entire entry as JSON";
    jsonBtn.addEventListener("click", () => void copyToClipboard(JSON.stringify(entry, null, 2), jsonBtn));
    head.appendChild(jsonBtn);
  }
  const close = el("button", "det-close");
  close.type = "button"; close.textContent = "×"; close.title = "Close detail";
  close.addEventListener("click", () => {
    selectedRequestId = null;
    selectedDetail = null;
    renderEntries();
  });
  head.appendChild(close);
  return head;
}

// Wraps an <h3> heading with a small copy button at the right edge —
// click to copy the supplied text. The button reuses the .det-action
// pill style so it lines up with the cURL/JSON buttons in the head.
function sectionHead(label, getText) {
  const head = el("div", "det-section-head");
  const h = document.createElement("h3"); h.textContent = label;
  head.appendChild(h);
  const btn = el("button", "det-action det-action--mini");
  btn.type = "button"; btn.textContent = "Copy"; btn.title = `Copy ${label}`;
  btn.addEventListener("click", () => void copyToClipboard(getText(), btn));
  head.appendChild(btn);
  return head;
}

function summarySection(e) {
  const sec = el("div", "det-section");
  const kvPairs = [
    ["Status", String(e.status ?? e.terminalState ?? "—") + (e.statusText ? ` ${e.statusText}` : "")],
    ["Duration", durationText(e)],
  ];
  if (e.mimeType) kvPairs.push(["MIME", e.mimeType]);
  if (e.timings?.startedAt) kvPairs.push(["Started", new Date(e.timings.startedAt).toLocaleTimeString()]);
  if (e.terminalState === "failed" && e.failureReason) kvPairs.push(["Failure", e.failureReason]);
  if (Array.isArray(e.redirectChain) && e.redirectChain.length > 0) {
    kvPairs.push(["Redirects", `${e.redirectChain.length} hop${e.redirectChain.length === 1 ? "" : "s"}`]);
  }
  kvPairs.push(["Request ID", e.requestId || ""]);
  kvPairs.push(["Source", e.source || "cdp"]);
  sec.appendChild(sectionHead("Summary", () => kvPairs.map(([k, v]) => `${k}: ${v}`).join("\n")));
  const dl = el("dl", "det-kv");
  for (const [k, v] of kvPairs) appendKV(dl, k, v);
  sec.appendChild(dl);
  return sec;
}

function headersSection(title, headers) {
  const sec = el("div", "det-section");
  const keys = Object.keys(headers || {}).sort();
  // Copy format: HTTP header style (`Name: value` lines) — pastes
  // straight into curl/Postman/etc.
  sec.appendChild(sectionHead(title, () => keys.map((k) => `${k}: ${headers[k]}`).join("\n")));
  if (keys.length === 0) {
    sec.appendChild(elText("det-empty", "(no headers)"));
  } else {
    const dl = el("dl", "det-kv det-headers");
    for (const k of keys) appendKV(dl, k, String(headers[k]));
    sec.appendChild(dl);
  }
  return sec;
}

function bodySection(title, capturedBody) {
  const sec = el("div", "det-section");
  // Copy format for bodies: text bodies copy as-is (pretty-printed if
  // JSON, like the rendered pre); binary/redacted/absent copy the same
  // human-readable placeholder the panel shows.
  sec.appendChild(sectionHead(title, () => capturedBodyToText(capturedBody)));
  sec.appendChild(renderCapturedBody(capturedBody));
  return sec;
}

function capturedBodyToText(b) {
  if (!b || typeof b !== "object") return "";
  if (b.kind === "text") return prettyJsonOrRaw(b.data) + (b.truncated ? `\n… truncated, ${b.droppedBytes} bytes dropped` : "");
  if (b.kind === "binary") return `<${b.mimeType || "binary"}, ${formatBytes(b.byteLength)}>`;
  if (b.kind === "redacted") {
    return b.reason === "mcp-default"
      ? "(redacted — enable `captureBodies: true` in the module config to see bodies)"
      : `(redacted: ${b.reason})`;
  }
  if (b.kind === "absent") {
    const why = b.reason === "204-or-304" ? "no content (204/304)"
              : b.reason === "fetch-failed" ? "fetch failed"
              : "not captured";
    return `(absent — ${why})`;
  }
  return "";
}

function renderCapturedBody(b) {
  if (!b || typeof b !== "object") return elText("det-empty", "(no body)");
  if (b.kind === "redacted") {
    return elText("det-pre det-pre--redacted",
      b.reason === "mcp-default"
        ? "(redacted — enable `captureBodies: true` in the module config to see bodies)"
        : `(redacted: ${b.reason})`);
  }
  if (b.kind === "absent") {
    const why = b.reason === "204-or-304" ? "no content (204/304)"
              : b.reason === "fetch-failed" ? "fetch failed"
              : "not captured";
    return elText("det-pre det-pre--absent", `(absent — ${why})`);
  }
  if (b.kind === "binary") {
    return elText("det-pre det-pre--binary", `<${b.mimeType || "binary"}, ${formatBytes(b.byteLength)}>`);
  }
  if (b.kind === "text") {
    const pre = el("pre", "det-pre");
    pre.textContent = prettyJsonOrRaw(b.data);
    const wrap = document.createDocumentFragment();
    wrap.appendChild(pre);
    if (b.truncated) {
      const t = elText("det-truncated", `… truncated, ${formatBytes(b.droppedBytes)} dropped`);
      wrap.appendChild(t);
    }
    return wrap;
  }
  return elText("det-empty", "(unknown body kind)");
}

function initiatorSection(initiator) {
  const sec = el("div", "det-section");
  let copyText = "";
  if (initiator.type === "script" && initiator.stack && Array.isArray(initiator.stack.callFrames)) {
    copyText = initiator.stack.callFrames.slice(0, 12)
      .map((f) => `  at ${f.functionName || "(anonymous)"} (${f.url}:${f.lineNumber}:${f.columnNumber})`)
      .join("\n");
  } else if (initiator.type === "parser") {
    copyText = `parser\nURL: ${initiator.url || ""}`;
  } else {
    copyText = String(initiator.type || "other");
  }
  sec.appendChild(sectionHead("Initiator", () => copyText));
  if (initiator.type === "script" && initiator.stack && Array.isArray(initiator.stack.callFrames)) {
    const pre = el("pre", "det-pre");
    pre.textContent = copyText;
    sec.appendChild(pre);
  } else if (initiator.type === "parser") {
    const dl = el("dl", "det-kv");
    appendKV(dl, "Type", "parser");
    appendKV(dl, "URL", initiator.url || "");
    sec.appendChild(dl);
  } else {
    const dl = el("dl", "det-kv");
    appendKV(dl, "Type", String(initiator.type || "other"));
    sec.appendChild(dl);
  }
  return sec;
}

function appendKV(dl, k, v) {
  const dt = document.createElement("dt"); dt.textContent = k;
  const dd = document.createElement("dd"); dd.textContent = v;
  dl.appendChild(dt); dl.appendChild(dd);
}

function elText(cls, text) {
  const d = document.createElement("div");
  d.className = cls;
  d.textContent = text;
  return d;
}

function prettyJsonOrRaw(data) {
  const s = String(data);
  const trimmed = s.trim();
  if (!trimmed) return s;
  if (trimmed[0] !== "{" && trimmed[0] !== "[") return s;
  try { return JSON.stringify(JSON.parse(trimmed), null, 2); } catch { return s; }
}

async function maybeRefreshSelectedDetail() {
  if (!selectedRequestId || !selectedDetail) return;
  const inList = lastEntries.find((e) => e.requestId === selectedRequestId);
  if (!inList) return;
  if (inList.terminalState === selectedDetail.terminalState) return;
  try {
    const reply = await rnDev.callTool("get", { requestId: selectedRequestId });
    if (reply?.kind === "error") return;
    selectedDetail = reply?.result ?? reply;
    renderDetail();
  } catch { /* swallow — next poll retries */ }
}

function formatBytes(n) {
  const num = Number(n);
  if (!Number.isFinite(num) || num < 0) return "?";
  if (num < 1024) return `${num} B`;
  if (num < 1024 * 1024) return `${(num / 1024).toFixed(1)} KB`;
  return `${(num / (1024 * 1024)).toFixed(2)} MB`;
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

// Coverage banner — informs the user that JS-layer-only capture
// doesn't include NSURLSession/OkHttp/Firebase/Sentry/image-loader/
// etc. traffic, and offers a (currently-disabled) "Enable native
// capture" toggle that's wired up to be flipped on when the future
// `@rn-dev/native-net-tap` opt-in module ships.
//
// Persistence: keep the dismissal in sessionStorage so it survives a
// soft reload of the panel but comes back next time the panel is
// mounted fresh.
const coverageBanner = document.getElementById("coverage-banner");
const coverageDismiss = document.getElementById("coverage-dismiss");
const coverageNativeBtn = document.getElementById("coverage-native-btn");
if (coverageBanner && coverageDismiss) {
  const KEY = "rndev.network.coverage-dismissed";
  try {
    if (window.sessionStorage?.getItem(KEY) === "1") coverageBanner.hidden = true;
  } catch { /* sessionStorage unavailable — keep banner visible */ }
  coverageDismiss.addEventListener("click", () => {
    coverageBanner.hidden = true;
    try { window.sessionStorage?.setItem(KEY, "1"); } catch { /* ignore */ }
  });
}
if (coverageNativeBtn) {
  // The button is disabled today (no native module to enable). Clicks
  // surface the same hint the title attr shows, in case the user
  // doesn't hover. Future work: detect the @rn-dev/native-net-tap
  // module and flip this on/off based on its install state.
  coverageNativeBtn.addEventListener("click", (e) => {
    e.preventDefault();
  });
}
followEl.addEventListener("change", () => {
  if (followEl.checked) {
    const wrap = contentEl.querySelector(".table-wrap");
    if (wrap) {
      suppressAutoToggle++;
      wrap.scrollTop = 0;
      requestAnimationFrame(() => requestAnimationFrame(() => { suppressAutoToggle = 0; }));
    }
  }
});

document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && selectedRequestId) {
    selectedRequestId = null;
    selectedDetail = null;
    renderEntries();
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
