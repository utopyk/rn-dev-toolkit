// Panel client for device-control. Runs in an isolated WebContentsView
// spawned by the rn-dev panel-bridge — the preload exposes
// `window.rnDev` with `callTool(tool, args?)` (invokes the module's own
// subprocess tools) plus `capabilities` / `call` for cross-module RPC.
//
// This panel only calls its own tools. Cross-module capability access
// isn't declared in `rn-dev-module.json#contributes.electron.panels[0].hostApi`
// so the preload wouldn't pass it through anyway.

/* global window, document */

const rnDev = /** @type {any} */ (window).rnDev;
const contentEl = document.getElementById("content");
const warningsEl = document.getElementById("warnings");
const refreshBtn = document.getElementById("refresh");

async function refresh() {
  if (!rnDev || typeof rnDev.callTool !== "function") {
    renderFatal("Panel preload unavailable — open the Devices panel from the sidebar.");
    return;
  }
  refreshBtn.disabled = true;
  refreshBtn.textContent = "Refreshing…";
  try {
    const reply = await rnDev.callTool("list", {});
    if (reply?.kind === "error") {
      renderFatal(`${reply.code}: ${reply.message}`);
      return;
    }
    const result = reply?.result ?? reply;
    renderDevices(result);
  } catch (err) {
    renderFatal(err instanceof Error ? err.message : String(err));
  } finally {
    refreshBtn.disabled = false;
    refreshBtn.textContent = "Refresh";
  }
}

function renderFatal(message) {
  warningsEl.innerHTML = "";
  contentEl.innerHTML = `<div class="error">${escapeHtml(message)}</div>`;
}

function renderDevices(result) {
  warningsEl.innerHTML = "";
  if (Array.isArray(result?.warnings) && result.warnings.length > 0) {
    for (const w of result.warnings) {
      const node = document.createElement("div");
      node.className = "warning";
      node.textContent = `${w.platform}: ${w.reason}`;
      warningsEl.appendChild(node);
    }
  }

  const devices = Array.isArray(result?.devices) ? result.devices : [];
  if (devices.length === 0) {
    contentEl.innerHTML =
      '<div class="empty">No devices connected. Boot an emulator or simulator, then Refresh.</div>';
    return;
  }

  const frag = document.createDocumentFragment();
  const grid = document.createElement("div");
  grid.className = "grid";
  for (const device of devices) {
    grid.appendChild(renderCard(device));
  }
  frag.appendChild(grid);
  contentEl.innerHTML = "";
  contentEl.appendChild(frag);
}

function renderCard(device) {
  const card = document.createElement("div");
  card.className = "card";

  const header = document.createElement("div");
  header.className = "card-header";
  const left = document.createElement("div");
  const name = document.createElement("div");
  name.className = "name";
  name.textContent = device.name || device.udid;
  const udid = document.createElement("div");
  udid.className = "udid";
  udid.textContent = device.udid;
  left.appendChild(name);
  left.appendChild(udid);

  const right = document.createElement("div");
  right.style.display = "flex";
  right.style.flexDirection = "column";
  right.style.gap = "4px";
  right.style.alignItems = "flex-end";
  const platformBadge = document.createElement("span");
  platformBadge.className = `badge badge--${device.platform}`;
  platformBadge.textContent = device.platform;
  const stateBadge = document.createElement("span");
  stateBadge.className = `badge badge--state-${device.state}`;
  stateBadge.textContent = device.state;
  right.appendChild(platformBadge);
  right.appendChild(stateBadge);

  header.appendChild(left);
  header.appendChild(right);
  card.appendChild(header);

  const actions = document.createElement("div");
  actions.className = "actions";
  const snapBtn = document.createElement("button");
  snapBtn.textContent = "Screenshot";
  const imgHolder = document.createElement("div");
  snapBtn.addEventListener("click", async () => {
    snapBtn.disabled = true;
    snapBtn.textContent = "…";
    try {
      const reply = await rnDev.callTool("screenshot", { udid: device.udid });
      if (reply?.kind === "error") {
        imgHolder.innerHTML = `<div class="error">${escapeHtml(reply.message)}</div>`;
        return;
      }
      const png = reply?.result?.pngBase64 ?? reply?.pngBase64;
      if (typeof png === "string" && png.length > 0) {
        const img = document.createElement("img");
        img.className = "preview";
        img.src = `data:image/png;base64,${png}`;
        imgHolder.innerHTML = "";
        imgHolder.appendChild(img);
      } else {
        imgHolder.innerHTML = '<div class="error">Screenshot returned no PNG bytes.</div>';
      }
    } catch (err) {
      imgHolder.innerHTML = `<div class="error">${escapeHtml(err instanceof Error ? err.message : String(err))}</div>`;
    } finally {
      snapBtn.disabled = false;
      snapBtn.textContent = "Screenshot";
    }
  });
  actions.appendChild(snapBtn);
  card.appendChild(actions);
  card.appendChild(imgHolder);

  return card;
}

function escapeHtml(raw) {
  return String(raw)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

refreshBtn.addEventListener("click", refresh);
refresh();
