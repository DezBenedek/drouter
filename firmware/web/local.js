import { mountControl, mountSimple } from "./shared/control.js";
import {
  installLocalization,
  languageControl,
  language,
} from "./shared/i18n.js";
import { Client, randomId } from "./shared/client.js";
import { theme, toggleTheme } from "./shared/theme.js";
const root = document.querySelector("#app");
const esc = (s) =>
  String(s ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
const icon = (path) =>
  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true">${path}</svg>`;
const icons = {
  Routing: icon('<path d="M4 5h16M4 12h16M4 19h16M8 2v20M16 2v20"/>'),
  Sources: icon('<path d="M4 5h16M4 12h16M4 19h16"/>'),
  "Simple Modes": icon('<rect x="4" y="4" width="16" height="16" rx="3"/>'),
  Devices: icon(
    '<rect x="3" y="4" width="18" height="13" rx="2"/><path d="M8 21h8M12 17v4"/>',
  ),
  Presets: icon('<path d="M7 4h14M7 12h14M7 20h14M2 4h1M2 12h1M2 20h1"/>'),
  Settings: icon(
    '<path d="M4 7h16M4 17h16"/><circle cx="9" cy="7" r="3"/><circle cx="16" cy="17" r="3"/>',
  ),
};
const brand = `<div class="brand"><span class="brand-symbol">${icon('<path d="M3 7h5c5 0 3 10 8 10h5M3 17h5c5 0 3-10 8-10h5"/><path d="m18 4 3 3-3 3m0 4 3 3-3 3"/>')}</span>DRouter</div>`;
const button = (text, action, attrs = "") =>
  `<button type="button" data-action="${action}" ${attrs}>${text}</button>`;
const field = (name, label, value = "", type = "text", extra = "") =>
  `<label class="field">${label}<input name="${name}" type="${type}" value="${esc(value)}" ${extra}></label>`;
const password = (name, label, required = false) =>
  `<label class="field">${label}<span class="password-control"><input aria-label="${label}" name="${name}" type="password" autocomplete="${name === "password" ? "current-password" : "new-password"}" ${required ? "required" : ""}>${button(icon('<path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7S2 12 2 12Z"/><circle cx="12" cy="12" r="3"/>'), "visibility", 'class="quiet" aria-label="Show password"')}</span></label>`;
const search = (label, value, id, cls = "") =>
  `<label class="search-field ${cls}"><span class="sr-only">${label}</span>${icon('<circle cx="10" cy="10" r="6"/><path d="m15 15 5 5"/>')}<input type="search" data-search="${id}" placeholder="${label}" value="${esc(value)}" autocomplete="off"></label>`;
const status = (online, text) =>
  `<span class="status-text"><span class="status-dot ${online ? "" : "offline"}"></span>${esc(text)}</span>`;
const row = (title, value, detail = "") =>
  `<div class="settings-row"><div class="settings-copy">${title}${detail ? `<span>${detail}</span>` : ""}</div>${value}</div>`;
const empty = (title, detail) =>
  `<div class="empty-state"><h2>${title}</h2><p>${detail}</p></div>`;
let client,
  data = {},
  page = "Routing",
  section = "",
  busy = false,
  message = "",
  failure = "",
  outputSearch = "",
  sourceSearch = "",
  pending = null,
  routeErrors = {},
  dragId;
let dialog, dialogSubmit, controlCleanup, restrictedCleanup;
function closeDialog() {
  if (dialog) {
    dialog.close();
    dialog.remove();
    dialog = null;
  }
}
function modal(
  title,
  body,
  submitLabel,
  submit,
  description = "",
  source = false,
) {
  closeDialog();
  const previous = document.activeElement;
  dialog = document.createElement("dialog");
  dialog.className = `dialog ${source ? "source-dialog" : ""}`;
  dialog.innerHTML = `<header class="dialog-header">${source ? button("‹", "close-dialog", 'class="quiet icon-button mobile-only" aria-label="Back to outputs"') : ""}<div><h2 id="dialog-title">${esc(title)}</h2>${description ? `<p>${esc(description)}</p>` : ""}</div>${button("×", "close-dialog", 'class="quiet icon-button" aria-label="Close"')}</header><div class="dialog-body"><form id="action-form"><div class="notice error" role="alert" hidden></div>${body}</form></div>${submitLabel ? `<footer class="dialog-footer">${button("Cancel", "close-dialog")}<button type="submit" form="action-form" class="primary">${submitLabel}</button></footer>` : ""}`;
  dialog.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      e.preventDefault();
      if (!busy) closeDialog();
    }
  });
  dialog.setAttribute("aria-labelledby", "dialog-title");
  document.body.append(dialog);
  dialogSubmit = submit;
  dialog.showModal();
  dialog.addEventListener(
    "close",
    () => previous?.isConnected && previous.focus(),
  );
  dialog.addEventListener("cancel", (e) => {
    e.preventDefault();
    if (!busy) closeDialog();
  });
  dialog.addEventListener("click", (e) => {
    if (e.target === dialog && !busy) closeDialog();
  });
  dialog.querySelector("form").onsubmit = async (e) => {
    e.preventDefault();
    await run(
      () => dialogSubmit(Object.fromEntries(new FormData(e.currentTarget))),
      true,
    );
  };
}
async function refresh() {
  if (!client) return;
  const values = await Promise.all(
    [
      "device.info",
      "device.health",
      "network.status",
      "receivers.list",
      "sources.list",
      "presets.list",
      "wifi.list",
    ].map((op) => client.call(op)),
  );
  data = {
    info: values[0],
    health: values[1],
    network: values[2],
    receivers: values[3],
    sources: values[4].sources,
    sourceErrors: values[4].errors,
    presets: values[5],
    wifi: values[6],
  };
}
async function run(task, close = false) {
  if (busy) return;
  busy = true;
  failure = "";
  render();
  const current = dialog;
  current?.querySelectorAll("button").forEach((b) => (b.disabled = true));
  try {
    await task();
    if (client) await refresh();
    if (close && dialog === current) closeDialog();
  } catch (e) {
    failure = e.message;
    if (dialog) {
      const el = dialog.querySelector(".notice");
      el.hidden = false;
      el.textContent = e.message;
    }
    try {
      if (client) await refresh();
    } catch {}
  } finally {
    busy = false;
    dialog?.querySelectorAll("button").forEach((b) => (b.disabled = false));
    render();
  }
}
function logout(text = "") {
  controlCleanup?.();
  restrictedCleanup?.();
  restrictedCleanup = null;
  controlCleanup = null;
  client?.close();
  client = null;
  data = {};
  closeDialog();
  login(text);
}
async function connect(p) {
  client = await new Client().open("", p, false);
  client.onDisconnect = () =>
    logout("Device unavailable or session expired. Connect again.");
  const session = await client.call("auth.session");
  if (session.role === "simple_mode") {
    restrictedCleanup = mountSimple(root, client, logout);
    return;
  }
  await refresh();
  render();
}
function login(error = "") {
  root.innerHTML = `<main class="auth-screen"><div class="auth-panel"><div class="auth-brand">${brand}${languageControl()}</div><h1>Connect to your DRouter</h1><p>Local device control</p><form id="login-form">${password("password", "Password", true)}<div class="notice error" ${error ? "" : "hidden"} role="alert">${esc(error)}</div><button class="primary auth-submit">Connect</button></form><div class="auth-foot"><span>Verified on this device</span>${button(theme() === "dark" ? "Light appearance" : "Dark appearance", "theme", 'class="quiet"')}</div></div></main>`;
  root.querySelector("form").onsubmit = async (e) => {
    e.preventDefault();
    const f = e.currentTarget;
    f.querySelector(".auth-submit").disabled = true;
    try {
      await connect(new FormData(f).get("password"));
      f.reset();
    } catch (e) {
      login(e.message);
    }
  };
}
let setupStep = 0,
  setupValues = { name: "", admin: "", profiles: [], cloud: false },
  setupNetwork = {};
function setup() {
  const s = setupValues;
  let content = "";
  if (setupStep === 0)
    content = `<div class="setup-welcome"><h1>Welcome to DRouter</h1><p>A direct connection between your NDI sources and BirdDog outputs.</p></div>`;
  if (setupStep === 1)
    content = `<h1>Name your device</h1><p class="section-caption">Choose a name and a password for this DRouter.</p>${field("name", "Device name", s.name, "text", 'required minlength="3" maxlength="32" autocomplete="username" autocapitalize="none" placeholder="studio-router"')}${password("admin", "Create administrator password", true)}<p class="help-text">Use 4–128 Unicode characters. Short passwords are weak; use a longer password when possible.</p>`;
  if (setupStep === 2)
    content = `<h1>Connect to your network</h1><p class="section-caption">Ethernet works automatically. Wi-Fi is optional.</p><div class="setup-feature"><span>Ethernet</span>${status(setupNetwork.ethernet?.link, setupNetwork.ethernet?.ip || "DHCP · connect a cable")}</div>${s.profiles.map((w, i) => `<div class="setup-network"><span class="priority">${i + 1}</span><div>${esc(w.ssid)}</div>${button("Remove", "setup-wifi-remove", `data-index="${i}"`)}</div>`).join("")}<div class="form-actions">${button("Add Wi-Fi network", "setup-wifi")}</div><details class="disclosure"><summary>Manual Ethernet settings</summary><div class="form-grid">${["address", "mask", "gateway", "dns"].map((k) => field(k, { address: "IPv4 address", mask: "Subnet mask", gateway: "Gateway", dns: "DNS server" }[k], s.ethernet?.[k] || "")).join("")}</div><p class="help-text">Leave the address empty for automatic DHCP.</p></details>`;
  if (setupStep === 3)
    content = `<h1>Access from anywhere</h1><p class="section-caption">Securely control your DRouter outside your local network.</p>${row("Enable remote access", `<input type="checkbox" role="switch" name="cloud" ${s.cloud ? "checked" : ""} aria-label="Enable remote access">`)}<p class="help-text">No cloud account required. Your device keeps all settings and verifies your password.</p>`;
  if (setupStep === 4)
    content = `<h1>Your DRouter is ready</h1><p class="section-caption">${esc(s.name)} is configured. You can change these settings at any time.</p><div class="finished-link"><span class="secondary">Local access</span><a href="${location.origin}">${esc(location.origin)}</a></div>${s.cloud ? `<div class="finished-link"><span class="secondary">Remote access</span><a href="https://drouter.dezso.hu/?device=${encodeURIComponent(s.name)}">drouter.dezso.hu · ${esc(s.name)}</a><small>Name reservation completes when the device connects. Check Remote Access settings for status.</small></div>` : ""}`;
  root.innerHTML = `<main class="auth-screen setup-screen"><form class="auth-panel setup-panel"><div class="auth-brand">${brand}${languageControl()}</div><div class="setup-progress" aria-label="Setup step ${setupStep + 1} of 5">${[0, 1, 2, 3, 4].map((i) => `<span class="${i <= setupStep ? "complete" : ""}"></span>`).join("")}</div><div class="setup-content">${content}<div class="notice inline error" role="alert" hidden></div></div><div class="setup-actions">${setupStep > 0 && setupStep < 4 ? button("Back", "setup-back") : "<span></span>"}<button class="primary">${setupStep === 3 ? "Finish setup" : setupStep === 4 ? "Open DRouter" : "Continue"}</button></div></form></main>`;
  if (setupStep === 1) {
    root.querySelector("[name=admin]").value = s.admin;
    root.querySelector("[name=admin]").autocomplete = "new-password";
  }
  root.querySelector("form").onsubmit = async (e) => {
    e.preventDefault();
    const f = Object.fromEntries(new FormData(e.currentTarget)),
      b = e.currentTarget.querySelector(".setup-actions .primary");
    b.disabled = true;
    try {
      if (setupStep === 1) {
        if (Array.from(f.admin).length < 4 || Array.from(f.admin).length > 128)
          throw Error("Password must contain 4–128 Unicode characters");
        Object.assign(s, f);
        const r = await fetch("/setup/network", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({}),
        });
        setupNetwork = await r.json();
        if (!r.ok)
          throw Error(
            setupNetwork.error ||
              "Unable to read network settings. Reload the page and try again.",
          );
      }
      if (setupStep === 2)
        s.ethernet = Object.fromEntries(
          ["address", "mask", "gateway", "dns"].map((k) => [k, f[k] || null]),
        );
      if (setupStep === 3) {
        s.cloud = !!f.cloud;
        const r = await fetch("/setup", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            name: s.name,
            password: s.admin,
            ethernet: s.ethernet || {},
            cloud_enabled: s.cloud,
            wifi_profiles: s.profiles,
          }),
        });
        const v = await r.json();
        if (!r.ok) throw Error(v.error);
      }
      if (setupStep === 4) {
        const p = s.admin;
        setupValues = {};
        await connect(p);
        return;
      }
      setupStep++;
      setup();
    } catch (e) {
      const el = root.querySelector(".notice");
      el.hidden = false;
      el.textContent = e.message;
    } finally {
      b.disabled = false;
    }
  };
}
function render() {
  if (!client || !data.info) return;
  controlCleanup?.();
  controlCleanup = null;
  const {
    info: i,
    health: h,
    network: n,
    receivers: r,
    sources: s,
    presets: p,
    wifi: w,
  } = data;
  const outputs = r.filter((x) =>
      x.config.label.toLowerCase().includes(outputSearch.toLowerCase()),
    ),
    sources = s.filter((x) =>
      x.name.toLowerCase().includes(sourceSearch.toLowerCase()),
    );
  let content = "",
    actions = "";
  if (page === "Routing") {
    actions = p.length
      ? `<select aria-label="Quick apply preset" data-select="preset"><option value="">Preset…</option>${p.map((x) => `<option value="${esc(x.id)}">${esc(x.name)}</option>`).join("")}</select>`
      : "";
    content = `<div class="page-body" id="control-host"></div>`;
  }
  if (["Sources", "Simple Modes"].includes(page))
    content = `<div class="page-body" id="control-host"></div>`;
  if (page === "Devices") {
    actions = button("Add receiver", "add-receiver", 'class="primary"');
    content = `<div class="page-body"><div class="routing-tools">${search("Find an output", outputSearch, "output")}${button("Discover", "discover")}</div><div class="data-list">${outputs.map((x) => `<div class="list-row"><div class="list-main"><strong>${esc(x.config.label)}</strong><span class="secondary">${esc(x.model || "BirdDog decoder")}<span class="mobile-only mobile-address">${esc(x.config.ip)}</span></span></div><span class="address mono">${esc(x.config.ip)}</span>${status(x.state.online, x.state.online ? "Online" : "Offline")}<span class="route-name secondary">${esc(x.state.source || "Unavailable")}</span>${button("···", "receiver-detail", `class="quiet icon-button" data-id="${esc(x.config.id)}" aria-label="Details for ${esc(x.config.label)}"`)}</div>`).join("")}</div>${!r.length ? empty("Add your first receiver", "Discover compatible devices or register a BirdDog by IP.") : ""}</div>`;
  }
  if (page === "Presets") {
    actions = button("Save current", "save-preset", 'class="primary"');
    content = `<div class="page-body"><div class="data-list">${p.map((x) => `<div class="list-row"><div class="list-main">${button(esc(x.name), "inspect-preset", `class="preset-name" data-id="${x.id}"`)}<span class="preset-detail">${x.routes.length} outputs</span></div>${button("Apply", "apply-preset", `data-id="${x.id}"`)}${button("···", "preset-detail", `class="quiet icon-button" data-id="${x.id}" aria-label="Edit ${esc(x.name)}"`)}</div>`).join("")}</div>${!p.length ? empty("Save a routing arrangement", "Presets capture verified output sources and stay on this DRouter.") : ""}</div>`;
  }
  if (page === "Settings") {
    const sections = [
        "General",
        "Access Control",
        "Ethernet",
        "Wi-Fi",
        "Remote Access",
        "Security",
        "System",
      ],
      current = section || "General";
    let body = "";
    if (current === "Access Control") body = `<div id="control-host"></div>`;
    if (current === "General")
      body =
        row(
          "Device name",
          `<span class="inline-actions">${esc(i.name)}${button("Change", "change-name")}</span>`,
          "Also used for remote login",
        ) +
        row(
          "Appearance",
          button(theme() === "dark" ? "Dark" : "Light", "theme"),
        ) +
        row(
          "Device identity",
          `<span class="mono secondary">${esc(i.device_id.slice(0, 16))}…</span>`,
          "Stable across name changes",
        );
    if (current === "Ethernet")
      body =
        row(
          "Connection",
          status(n.ethernet.link, n.ethernet.ip || "Disconnected"),
        ) +
        `<form data-form="ethernet"><div class="form-grid form-spaced">${["address", "mask", "gateway", "dns"].map((k) => field(k, { address: "IPv4 address", mask: "Subnet mask", gateway: "Gateway", dns: "DNS server" }[k], i.ethernet_config[k] || "")).join("")}</div><p class="help-text">Leave the address empty to use automatic DHCP.</p><div class="form-actions"><button class="primary">Save Ethernet</button></div></form>`;
    if (current === "Wi-Fi")
      body =
        button("Add network", "wifi-edit") +
        `<div class="data-list list-spaced">${w.map((x, index) => `<div class="wifi-row ${x.enabled ? "" : "disabled"}" draggable="true" data-wifi="${esc(x.id)}"><span class="priority">${index + 1}</span><div class="wifi-copy"><strong>${esc(x.ssid)}</strong><span class="secondary">${n.wifi.connected && n.wifi.active === x.id ? "Connected" : x.enabled ? "Saved" : "Disabled"}</span></div><div class="wifi-actions">${button("↑", "wifi-up", `class="quiet icon-button" data-id="${x.id}" aria-label="Move ${esc(x.ssid)} up" ${index === 0 ? "disabled" : ""}`)}${button("↓", "wifi-down", `class="quiet icon-button" data-id="${x.id}" aria-label="Move ${esc(x.ssid)} down" ${index === w.length - 1 ? "disabled" : ""}`)}${button("Edit", "wifi-edit", `class="quiet edit-network" data-id="${x.id}"`)}<input type="checkbox" role="switch" data-toggle-wifi="${x.id}" aria-label="Enable ${esc(x.ssid)}" ${x.enabled ? "checked" : ""}>${button("···", "wifi-more", `class="quiet icon-button" data-id="${x.id}" aria-label="More options for ${esc(x.ssid)}"`)}</div></div>`).join("")}</div><p class="help-text">Passwords stay on this device. Drag rows or use arrows to change priority.</p><details class="disclosure"><summary>Priority behavior</summary><form data-form="policy">${field("preferred", "Preferred network check interval (seconds)", i.wifi_policy.preferred_check_secs, "number", 'min="60" max="3600"')}${field("retry", "Reconnect cooldown (seconds)", i.wifi_policy.retry_secs, "number", 'min="5" max="120"')}<label class="field-row"><input type="checkbox" name="prefer" ${i.wifi_policy.prefer_higher ? "checked" : ""}>Prefer higher-priority networks when stable</label><div class="form-actions"><button>Save behavior</button></div></form></details>`;
    if (current === "Remote Access")
      body =
        row(
          "Remote access",
          `<input type="checkbox" role="switch" data-toggle-cloud aria-label="Enable remote access" ${i.cloud_enabled ? "checked" : ""}>`,
          "Your device initiates the secure connection",
        ) +
        row(
          "Cloud connection",
          `<span class="secondary">${esc(n.cloud === "name_unavailable" ? "Name reserved — choose another name" : n.cloud)}</span>`,
        ) +
        row(
          "Registered name",
          `<span>${esc(n.registered_name || "Not registered yet")}</span>`,
        ) +
        row(
          "Remote address",
          `<a href="${esc(i.server)}/?device=${encodeURIComponent(i.name)}" target="_blank" rel="noreferrer">${esc(i.server.replace(/^https?:\/\//, ""))}</a>`,
        ) +
        row(
          "Last connected",
          `<span class="secondary">${n.last_cloud_connection ? new Date(n.last_cloud_connection * 1000).toLocaleString(language()) : "Not yet"}</span>`,
        ) +
        `<details class="disclosure"><summary>Advanced · custom server</summary><form data-form="server">${field("server", "Server URL", i.server, "url", "required")}<div class="form-actions"><button>Save server</button></div></form></details><p class="help-text">Cloudflare reserves only your name and public identity. All device settings stay here.</p>`;
    if (current === "Security")
      body =
        row(
          "Administrator password",
          button("Change", "change-password"),
          "Verified only on this device",
        ) +
        row(
          "Active sessions",
          button("Revoke all", "revoke"),
          "Sessions expire after 30 minutes",
        ) +
        row(
          "Identity recovery",
          button("Export recovery file", "identity-export"),
          "Keep the file private. It proves ownership of reserved names.",
        ) +
        row(
          "Restore an identity",
          button("Restore…", "identity-restore"),
          "Requires your recovery file and a new administrator password",
        );
    if (current === "System")
      body =
        row("Firmware", `<span class="mono">${esc(i.version)}</span>`) +
        row(
          "Uptime",
          `<span class="mono">${Math.floor(h.uptime / 3600)}h ${Math.floor(h.uptime / 60) % 60}m</span>`,
        ) +
        row(
          "Available memory",
          `<span class="mono">${h.free_memory ? Math.round(h.free_memory / 1024) + " KiB" : "Host managed"}</span>`,
        ) +
        row(
          "Configuration storage",
          `<span class="mono">${Math.round((h.config_bytes || 0) / 102.4) / 10} / 24 KiB</span>`,
        ) +
        row("Recorded errors", `<span>${h.errors}</span>`) +
        row(
          "Factory reset",
          button("Erase device…", "reset", 'class="danger"'),
          "Reserved cloud names remain protected by your existing identity. Export recovery first.",
        );
    content = `<div class="page-body"><div class="settings-layout" ${section ? `data-section="${esc(section)}"` : ""}><nav class="settings-nav" aria-label="Settings sections">${sections.map((x) => button(x, "settings-section", `data-section="${x}" ${current === x ? 'aria-current="page"' : ""}`)).join("")}</nav><section class="settings-section">${button("‹ Settings", "settings-back", 'class="settings-back"')}<h2>${current}</h2><p class="section-caption">${{ General: "The name and identity of this DRouter.", Ethernet: "The wired connection to your BirdDog network.", "Wi-Fi": "Networks are tried from highest to lowest priority.", "Remote Access": "Connect securely from outside your local network.", "Access Control": "Simple Mode and Event Mode access.", Security: "Your device is the only password authority.", System: "Software, storage, and recovery." }[current]}</p>${body}</section></div></div>`;
  }
  root.innerHTML = `<a class="skip-link" href="#main">Skip to content</a><div class="app-shell"><header class="app-topbar">${brand}<div class="app-device"><strong>${esc(i.name)}</strong><span class="secondary">Local</span></div><div class="topbar-actions"><span class="event-indicator" ${i.event_mode ? "" : "hidden"}>Event Mode</span>${languageControl()}${status(true, "Local connection")}${button(theme() === "dark" ? "☀" : "☾", "theme", 'class="quiet icon-button" aria-label="Change appearance"')}${button("↪", "logout", 'class="quiet icon-button" aria-label="Disconnect"')}</div></header><nav class="app-nav" aria-label="Main navigation">${Object.keys(
    icons,
  )
    .map((t) =>
      button(
        icons[t] + `<span>${t}</span>`,
        "page",
        `data-page="${t}" ${page === t ? 'aria-current="page"' : ""}`,
      ),
    )
    .join(
      "",
    )}<div class="nav-footer">Standalone by design<br>DRouter ${esc(i.version)}</div></nav><main id="main" class="app-main"><header class="page-header"><div class="page-heading"><h1>${page}</h1><p class="secondary">${page === "Routing" ? `${r.filter((x) => x.state.online).length} of ${r.length} outputs online · ${s.length} sources` : page === "Devices" ? "BirdDog receivers on your network" : page === "Presets" ? "Routing arrangements saved on this device" : "Device preferences and connectivity"}</p></div><div class="page-actions">${actions}</div></header>${failure && !dialog ? `<div class="notice error" role="alert">${esc(failure)}</div>` : ""}${message ? `<div class="notice success" role="status">${esc(message)}</div>` : ""}${content}</main></div>`;
  if (root.querySelector("#control-host"))
    controlCleanup = mountControl(
      root.querySelector("#control-host"),
      client,
      page === "Settings" ? "Access Control" : page,
      async () => {
        data.info = await client.call("device.info");
      },
    );
  root.querySelectorAll("[data-wifi]").forEach((el) => {
    el.ondragstart = () => (dragId = el.dataset.wifi);
    el.ondragover = (e) => e.preventDefault();
    el.ondrop = (e) => {
      e.preventDefault();
      const ids = w.map((x) => x.id).filter((x) => x !== dragId);
      ids.splice(
        w.findIndex((x) => x.id === el.dataset.wifi),
        0,
        dragId,
      );
      if (dragId) run(() => client.call("wifi.reorder", { ids }));
    };
  });
  root.querySelectorAll("[data-form]").forEach(
    (f) =>
      (f.onsubmit = (e) => {
        e.preventDefault();
        const v = Object.fromEntries(new FormData(f));
        run(() =>
          f.dataset.form === "policy"
            ? settings({
                wifi_policy: {
                  preferred_check_secs: +v.preferred,
                  retry_secs: +v.retry,
                  prefer_higher: !!v.prefer,
                },
              })
            : f.dataset.form === "server"
              ? settings({ server: v.server })
              : settings({
                  ethernet: Object.fromEntries(
                    ["address", "mask", "gateway", "dns"].map((k) => [
                      k,
                      v[k] || null,
                    ]),
                  ),
                }),
        );
      }),
  );
}
async function settings(values) {
  return client.call("settings.update", {
    expected_revision: data.info.revision,
    ...values,
  });
}
function picker(id) {
  const r = data.receivers.find((x) => x.config.id === id);
  modal(
    "Choose a source",
    `<div class="source-search">${search("Search sources", "", "picker")}</div><p class="source-current">Current: ${esc(r.state.source || "No source")}</p><div class="source-list">${data.sources.map((s) => button(`<span class="source-name">${esc(s.name)}</span>${s.name === r.state.source ? "✓" : ""}`, "route", `class="source-option ${s.name === r.state.source ? "active" : ""}" data-id="${id}" data-source="${esc(s.name)}" aria-label="${esc(s.name)}" aria-pressed="${s.name === r.state.source}"`)).join("")}</div>`,
    null,
    null,
    r.config.label,
    true,
  );
}
function presetBody(p) {
  return p.routes
    .map(
      ([id, source]) =>
        `<div class="preset-route"><span>${esc(data.receivers.find((x) => x.config.id === id)?.config.label || "Removed output")}<small>${esc(data.receivers.find((x) => x.config.id === id)?.state.source || "Unavailable")}</small></span><span>${esc(source)}</span></div>`,
    )
    .join("");
}
function applyPreset(p) {
  modal(
    `Apply ${p.name}?`,
    presetBody(p),
    "Apply preset",
    async () => {
      const v = await client.call("presets.apply", { id: p.id });
      message = v.results
        .map(
          (x) =>
            `${data.receivers.find((r) => r.config.id === x.receiver)?.config.label || x.receiver}: ${x.ok ? "Verified" : x.error}`,
        )
        .join("\n");
    },
    `${p.routes.length} outputs will be updated and verified.`,
  );
}
function editWifi(w) {
  modal(
    w ? "Edit network" : "Add Wi-Fi network",
    field(
      "ssid",
      "Network name",
      w?.ssid || "",
      "text",
      'required maxlength="32" autocomplete="off"',
    ) +
      password(
        "wifi_password",
        w ? "New password (leave blank to keep)" : "Wi-Fi password",
        !w,
      ),
    "Save network",
    (f) =>
      client.call("wifi.add", {
        id: w?.id || randomId(),
        ssid: f.ssid,
        ...(f.wifi_password ? { password: f.wifi_password } : {}),
      }),
  );
  dialog.querySelector("input[type=password]").autocomplete = "new-password";
}
async function action(d) {
  if (d.action === "visibility") {
    const b = d.element,
      input = b.parentElement.querySelector("input");
    input.type = input.type === "password" ? "text" : "password";
    b.setAttribute(
      "aria-label",
      input.type === "password" ? "Show password" : "Hide password",
    );
    return;
  }
  if (d.action === "theme") {
    toggleTheme();
    if (client) render();
    return;
  }
  if (d.action === "close-dialog") {
    if (!busy) closeDialog();
    return;
  }
  if (d.action === "page") {
    page = d.page;
    section = "";
    message = "";
    failure = "";
    outputSearch = "";
    render();
    return;
  }
  if (d.action === "settings-section" || d.action === "settings-back") {
    section = d.section || "";
    render();
    return;
  }
  if (d.action === "logout") {
    logout();
    return;
  }
  if (d.action === "setup-back") {
    setupStep--;
    setup();
    return;
  }
  if (d.action === "setup-wifi-remove") {
    setupValues.profiles.splice(+d.index, 1);
    setup();
    return;
  }
  if (d.action === "setup-wifi") {
    modal(
      "Add Wi-Fi network",
      `${setupNetwork.networks?.length ? `<label class="field">Available networks<select data-available><option value="">Choose a network…</option>${setupNetwork.networks.map((s) => `<option>${esc(s)}</option>`).join("")}</select></label>` : ""}${field("ssid", "Network name", "", "text", 'required maxlength="32"')}${password("wifi_password", "Wi-Fi password", true)}`,
      "Add network",
      async (f) => {
        setupValues.profiles.push({
          id: randomId(),
          ssid: f.ssid,
          password: f.wifi_password,
          enabled: true,
          priority: setupValues.profiles.length,
        });
        setup();
      },
    );
    return;
  }
  if (d.action === "pick-source") {
    picker(d.id);
    return;
  }
  if (d.action === "route") {
    closeDialog();
    pending = { id: d.id, source: d.source };
    delete routeErrors[d.id];
    await run(async () => {
      try {
        await client.call("route.set", { receiver: d.id, source: d.source });
      } catch (e) {
        routeErrors[d.id] = e.message;
        throw e;
      } finally {
        pending = null;
      }
    });
    return;
  }
  if (d.action === "add-receiver") {
    modal(
      "Add receiver",
      field("label", "Receiver name", "", "text", "required") +
        field(
          "ip",
          "IPv4 address",
          "",
          "text",
          'required inputmode="decimal"',
        ) +
        `<details class="disclosure"><summary>Advanced</summary>${field("port", "API port", "8080", "number", 'min="1" max="65535"')}${field("channel", "Channel", "1", "number", 'min="1" max="16"')}</details>`,
      "Add receiver",
      (f) =>
        client.call("receivers.add", {
          id: randomId(),
          label: f.label,
          ip: f.ip,
          port: +f.port,
          channel: +f.channel,
        }),
    );
    return;
  }
  if (d.action === "receiver-detail") {
    const r = data.receivers.find((x) => x.config.id === d.id);
    modal(
      r.config.label,
      row("Address", `<span>${esc(r.config.ip)}:${r.config.port}</span>`) +
        row(
          "Current source",
          `<span>${esc(r.state.source || "Unavailable")}</span>`,
        ) +
        `<div class="form-actions">${button("Rename", "rename-receiver", `data-id="${d.id}"`)}${button("Remove", "remove-receiver", `data-id="${d.id}" class="danger"`)}</div>`,
    );
    return;
  }
  if (d.action === "save-preset") {
    modal(
      "Save current routing",
      field("name", "Preset name", "", "text", "required"),
      "Save preset",
      (f) => client.call("presets.create", { name: f.name }),
      "Capture the actual sources reported by your outputs.",
    );
    return;
  }
  if (["apply-preset", "inspect-preset", "preset-detail"].includes(d.action)) {
    const p = data.presets.find((x) => x.id === d.id);
    if (d.action === "apply-preset") applyPreset(p);
    else
      modal(
        p.name,
        presetBody(p) +
          (d.action === "preset-detail"
            ? `<div class="form-actions">${button("Rename", "rename-preset", `data-id="${p.id}"`)}${button("Delete", "delete-preset", `data-id="${p.id}" class="danger"`)}</div>`
            : ""),
      );
    return;
  }
  if (d.action === "rename-preset" || d.action === "rename-receiver") {
    const preset = d.action === "rename-preset",
      item = (preset ? data.presets : data.receivers).find(
        (x) => (x.id || x.config.id) === d.id,
      );
    modal(
      "Rename " + (preset ? "preset" : "receiver"),
      field("name", "Name", item.name || item.config.label, "text", "required"),
      "Save name",
      (f) =>
        client.call(preset ? "presets.update" : "receivers.rename", {
          id: d.id,
          name: f.name,
        }),
    );
    return;
  }
  if (d.action === "delete-preset" || d.action === "remove-receiver") {
    modal(
      d.action === "delete-preset" ? "Delete preset?" : "Remove receiver?",
      "<p>This removes the saved entry from your DRouter.</p>",
      "Remove",
      () =>
        client.call(
          d.action === "delete-preset" ? "presets.delete" : "receivers.remove",
          { id: d.id },
        ),
    );
    return;
  }
  if (d.action === "wifi-edit") {
    editWifi(data.wifi.find((x) => x.id === d.id));
    return;
  }
  if (d.action === "wifi-more") {
    const w = data.wifi.find((x) => x.id === d.id);
    modal(
      w.ssid,
      `<div class="inline-actions">${button("Reconnect", "wifi-connect", `data-id="${w.id}" ${w.enabled ? "" : "disabled"}`)}${button("Remove", "wifi-remove", `data-id="${w.id}" class="danger"`)}</div>`,
    );
    return;
  }
  if (d.action === "wifi-remove") {
    modal(
      "Remove network?",
      "<p>If the connection is lost, use Ethernet or hold BOOT for three seconds to open the recovery access point.</p>",
      "Remove network",
      () => client.call("wifi.remove", { id: d.id }),
    );
    return;
  }
  if (d.action === "wifi-up" || d.action === "wifi-down") {
    const ids = data.wifi.map((x) => x.id),
      i = ids.indexOf(d.id),
      j = i + (d.action === "wifi-up" ? -1 : 1);
    [ids[i], ids[j]] = [ids[j], ids[i]];
    await run(() => client.call("wifi.reorder", { ids }));
    return;
  }
  if (d.action === "change-name") {
    modal(
      "Change device name",
      field(
        "name",
        "Device name",
        data.info.name,
        "text",
        'required minlength="3" maxlength="32"',
      ),
      "Save name",
      async (f) => {
        await settings({ name: f.name });
        logout("Device name changed. Connect again.");
      },
      "Your identity stays the same. Previously registered names remain reserved.",
    );
    return;
  }
  if (d.action === "change-password") {
    modal(
      "Change password",
      password("admin", "New administrator password", true),
      "Change password",
      async (f) => {
        await settings({ password: f.admin });
        logout("Password changed. All sessions were revoked.");
      },
      "Use 4–128 Unicode characters. Every session will need to reconnect.",
    );

    return;
  }
  if (d.action === "identity-export") {
    modal(
      "Save identity recovery file",
      "<p>This private file proves ownership of your reserved names. Keep an offline copy in a secure place.</p>",
      "Export recovery",
      async () => {
        const v = await client.call("identity.export");
        const url = URL.createObjectURL(
          new Blob([JSON.stringify(v)], { type: "application/json" }),
        );
        const a = document.createElement("a");
        a.href = url;
        a.download = `drouter-${data.info.name}-recovery.json`;
        a.click();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
      },
    );
    return;
  }
  if (d.action === "identity-restore") {
    modal(
      "Restore device identity",
      field(
        "recovery",
        "Recovery file",
        "",
        "file",
        'required accept="application/json"',
      ) +
        field(
          "name",
          "Reserved device name",
          data.info.name,
          "text",
          "required",
        ) +
        password("admin", "Create a new administrator password", true),
      "Restore identity",
      async (f) => {
        const file = dialog.querySelector("[name=recovery]").files[0],
          v = JSON.parse(await file.text());
        if (v.v !== 1 || !v.identity) throw Error("Invalid recovery file");
        await client.call("identity.restore", {
          identity: v.identity,
          name: f.name,
          password: f.admin,
          expected_revision: data.info.revision,
        });
        logout("Identity restored. Connect with the new password.");
      },
      "Restores name ownership. Other device settings remain on this device.",
    );
    return;
  }
  if (d.action === "revoke" || d.action === "reset") {
    modal(
      d.action === "reset" ? "Erase this DRouter?" : "Revoke all sessions?",
      `<p>${d.action === "reset" ? "Export your identity recovery file before erasing. A new identity cannot take over your reserved cloud names. Physical provisioning will be required." : "Every local and remote session will need to connect again."}</p>`,
      d.action === "reset" ? "Erase device" : "Revoke sessions",
      async () => {
        await client.call(
          d.action === "reset" ? "factory.reset" : "sessions.revoke",
        );
        if (d.action === "reset") {
          client.close();
          client = null;
          setupValues = {
            name: "",
            admin: "",
            profiles: [],
            cloud: false,
          };
          setupStep = 0;
          closeDialog();
          setup();
        } else logout("Sessions revoked.");
      },
    );
    return;
  }
  await run(async () => {
    if (d.action === "refresh-sources") await client.call("sources.refresh");
    if (d.action === "wifi-connect") {
      await client.call("wifi.connect", { id: d.id });
      closeDialog();
    }
    if (d.action === "discover") {
      const found = await client.call("receivers.discover");
      for (const r of found) await client.call("receivers.add", r);
      message = found.length
        ? `${found.length} verified receivers added.`
        : "No receivers found. Add a receiver by IP.";
    }
  });
}
document.addEventListener("click", (e) => {
  const b = e.target.closest("[data-action]");
  if (b && !b.disabled) void action({ ...b.dataset, element: b });
});
document.addEventListener("input", (e) => {
  const id = e.target.dataset.search;
  if (!id) return;
  if (id === "picker") {
    const q = e.target.value.toLowerCase();
    dialog
      .querySelectorAll(".source-option")
      .forEach((b) => (b.hidden = !b.textContent.toLowerCase().includes(q)));
    return;
  }
  const pos = e.target.selectionStart;
  if (id === "output") outputSearch = e.target.value;
  else sourceSearch = e.target.value;
  render();
  const input = root.querySelector(`[data-search="${id}"]`);
  input?.focus();
  if (input?.type !== "search") input?.setSelectionRange(pos, pos);
});
document.addEventListener("change", (e) => {
  if (e.target.matches("[data-toggle-wifi]"))
    void run(() =>
      client.call("wifi.set_enabled", {
        id: e.target.dataset.toggleWifi,
        enabled: e.target.checked,
      }),
    );
  if (e.target.matches("[data-toggle-cloud]"))
    void run(() => settings({ cloud_enabled: e.target.checked }));
  if (e.target.matches("[data-select=preset]") && e.target.value)
    applyPreset(data.presets.find((x) => x.id === e.target.value));
  if (e.target.matches("[data-available]"))
    dialog.querySelector("[name=ssid]").value = e.target.value;
});
document.addEventListener("keydown", (e) => {
  const t = e.target;
  if (!t.matches(".crosspoint")) return;
  const moves = {
      ArrowRight: [0, 1],
      ArrowLeft: [0, -1],
      ArrowUp: [-1, 0],
      ArrowDown: [1, 0],
    },
    move = moves[e.key];
  if (move) {
    e.preventDefault();
    root
      .querySelector(
        `[data-row="${+t.dataset.row + move[0]}"][data-col="${+t.dataset.col + move[1]}"]`,
      )
      ?.focus();
  }
});
setInterval(() => {
  if (
    client &&
    !busy &&
    !dialog &&
    !controlCleanup &&
    !restrictedCleanup &&
    document.visibilityState === "visible"
  )
    void refresh()
      .then(render)
      .catch(() => logout("Connection lost. Connect again."));
}, 20000);
fetch("/bootstrap")
  .then((r) => r.json())
  .then((b) => (b.setup ? setup() : login()))
  .catch((e) => {
    root.textContent = e.message;
  });

installLocalization();

window.addEventListener("pagehide", () => client?.close());
