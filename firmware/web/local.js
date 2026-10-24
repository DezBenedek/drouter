import {
  mountControl,
  installActivity,
  installSettingsSidebar,
  beginTask,
  mountSimple,
  toggleEvent,
  eventControl,
  toast,
  dismissToast,
} from "./shared/control.js";
import { installLocalization, languageControl } from "./shared/i18n.js";
import { Client, randomId, remoteStatus } from "./shared/client.js";
import "./shared/theme.js";
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
const status = (online, text) =>
  `<span class="status-text"><span class="status-dot ${online ? "" : "offline"}"></span>${esc(text)}</span>`;
const row = (title, value, detail = "") =>
  `<div class="settings-row"><div class="settings-copy">${title}${detail ? `<span>${detail}</span>` : ""}</div>${value}</div>`;
let client,
  data = {},
  page = "Routing",
  busy = false,
  message = "",
  failure = "";
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
  dialog.innerHTML = `<header class="dialog-header">${source ? button("‹", "close-dialog", 'class="quiet icon-button mobile-only" aria-label="Back to outputs"') : ""}<div><h2 id="dialog-title">${esc(title)}</h2>${description ? `<p>${esc(description)}</p>` : ""}</div>${button("×", "close-dialog", 'class="quiet icon-button" aria-label="Close"')}</header><div class="dialog-body"><form id="action-form">${body}</form></div>${submitLabel ? `<footer class="dialog-footer">${button("Cancel", "close-dialog")}<button type="submit" form="action-form" class="primary">${submitLabel}</button></footer>` : ""}`;
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
    ["device.info", "device.health", "network.status", "wifi.list"].map((op) =>
      client.call(op),
    ),
  );
  data = {
    info: values[0],
    health: values[1],
    network: values[2],
    wifi: values[3],
  };
}
async function run(task, close = false) {
  if (busy) return;
  busy = true;
  failure = "";
  const current = dialog;
  const activity = beginTask("Settings");
  current?.querySelectorAll("button").forEach((b) => (b.disabled = true));
  try {
    await task();
    activity.done();
    if (client) await refresh();
    if (close && dialog === current) closeDialog();
  } catch (e) {
    failure = e.message;
    activity.fail(e.message);
    try {
      if (client) await refresh();
    } catch {}
  } finally {
    busy = false;
    dialog?.querySelectorAll("button").forEach((b) => (b.disabled = false));
    render();
    if (failure || message)
      toast(
        failure || message,
        failure ? "error" : "success",
        "local-operation",
      );
    failure = "";
    message = "";
  }
}
function logout(text = "", kind = "error") {
  page = "Routing";
  dismissToast();
  controlCleanup?.();
  restrictedCleanup?.();
  restrictedCleanup = null;
  controlCleanup = null;
  if (client) {
    client.onDisconnect = () => {};
    client.close();
  }
  client = null;
  data = {};
  closeDialog();
  login(text, kind);
}
async function acceptClient(next) {
  client = next;
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
async function connect(p) {
  return acceptClient(await new Client().open("", p, false));
}
function login(error = "", kind = "error") {
  if (error) toast(error, kind, "login-error");
  root.innerHTML = `<main class="auth-screen"><div class="auth-panel"><div class="auth-brand">${brand}${languageControl()}</div><h1>Connect to your DRouter</h1><p>Enter your password.</p><form id="login-form">${password("password", "Password", true)}<button class="primary auth-submit">Connect</button></form></div></main>`;
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
    content = `<h1>Name your device</h1>${field("name", "Device name", s.name, "text", 'required minlength="3" maxlength="32" autocomplete="username" autocapitalize="none" placeholder="studio-router"')}${password("admin", "Create administrator password", true)}<p class="help-text">Use 4–128 Unicode characters. Short passwords are weak; use a longer password when possible.</p>`;
  if (setupStep === 2)
    content = `<h1>Connect to your network</h1><p class="section-caption">Ethernet works automatically. Wi-Fi is optional.</p><div class="setup-feature"><span>Ethernet</span>${status(setupNetwork.ethernet?.link, setupNetwork.ethernet?.ip || "DHCP · connect a cable")}</div>${s.profiles.map((w, i) => `<div class="setup-network"><span class="priority">${i + 1}</span><div>${esc(w.ssid)}</div>${button("Remove", "setup-wifi-remove", `data-index="${i}"`)}</div>`).join("")}<div class="form-actions">${button("Add Wi-Fi network", "setup-wifi")}</div><details class="disclosure"><summary>Manual Ethernet settings</summary><div class="form-grid">${["address", "mask", "gateway", "dns"].map((k) => field(k, { address: "IPv4 address", mask: "Subnet mask", gateway: "Gateway", dns: "DNS server" }[k], s.ethernet?.[k] || "")).join("")}</div><p class="help-text">Leave the address empty for automatic DHCP.</p></details>`;
  if (setupStep === 3)
    content = `<h1>Access from anywhere</h1><p class="section-caption">Securely control your DRouter outside your local network.</p>${row("Enable remote access", `<input type="checkbox" role="switch" name="cloud" ${s.cloud ? "checked" : ""} aria-label="Enable remote access">`)}<p class="help-text">No cloud account required. Your device keeps all settings and verifies your password.</p>`;
  if (setupStep === 4)
    content = `<h1>Your DRouter is ready</h1><p class="section-caption">${esc(s.name)} is configured. You can change these settings at any time.</p><div class="finished-link"><span class="secondary">Local access</span><a href="${location.origin}">${esc(location.origin)}</a></div>${s.cloud ? `<div class="finished-link"><span class="secondary">Remote access</span><a href="https://drouter.dezso.hu/?device=${encodeURIComponent(s.name)}">drouter.dezso.hu · ${esc(s.name)}</a><small>Name reservation completes when the device connects. Check Remote Access settings for status.</small></div>` : ""}`;
  root.innerHTML = `<main class="auth-screen setup-screen"><form class="auth-panel setup-panel"><div class="auth-brand">${brand}${languageControl()}</div><div class="setup-progress" aria-label="Setup step ${setupStep + 1} of 5">${[0, 1, 2, 3, 4].map((i) => `<span class="${i <= setupStep ? "complete" : ""}"></span>`).join("")}</div><div class="setup-content">${content}</div><div class="setup-actions">${setupStep > 0 && setupStep < 4 ? button("Back", "setup-back") : "<span></span>"}<button class="primary">${setupStep === 3 ? "Finish setup" : setupStep === 4 ? "Open DRouter" : "Continue"}</button></div></form></main>`;
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
      toast(e.message, "error", "setup-error");
    } finally {
      b.disabled = false;
    }
  };
}
function render() {
  if (!client || !data.info) return;
  controlCleanup?.();
  controlCleanup = null;
  const { info: i, health: h, network: n, wifi: w } = data;
  let content = "";
  if (page === "Settings") {
    content = `<div class="page-body settings-single">
      <section class="settings-card"><div id="access-host"></div></section>
      <section class="settings-card" aria-label="Device"><h2>Device</h2>
        ${row("Device name", `<span class="inline-actions">${esc(i.name)}${button("Change", "change-name")}</span>`, "Also used for remote login")}
      </section>
      <details class="settings-card"><summary>Network</summary>
        ${row("Ethernet", `<span data-ethernet-status>${status(n.ethernet.link, n.ethernet.ip || "Disconnected")}</span>`)}
        <form data-form="ethernet"><div class="form-grid">${["address", "mask", "gateway", "dns"].map((k) => field(k, { address: "IPv4 address", mask: "Subnet mask", gateway: "Gateway", dns: "DNS server" }[k], i.ethernet_config[k] || "")).join("")}</div><p class="help-text">Leave the address empty to use automatic DHCP.</p><div class="form-actions"><button class="primary">Save Ethernet</button></div></form>
        <h3>Wi-Fi</h3>
        ${button("Add network", "wifi-edit")}
        <div class="data-list list-spaced">${w.map((x, index) => `<div class="wifi-row ${x.enabled ? "" : "disabled"}" data-wifi="${esc(x.id)}"><span class="priority">${index + 1}</span><div class="wifi-copy"><strong>${esc(x.ssid)}</strong><span class="secondary">${n.wifi.connected && n.wifi.active === x.id ? "Connected" : x.enabled ? "Saved" : "Disabled"}</span></div><div class="wifi-actions">${button("↑", "wifi-up", `class="quiet icon-button" data-id="${x.id}" aria-label="Move ${esc(x.ssid)} up" ${index === 0 ? "disabled" : ""}`)}${button("↓", "wifi-down", `class="quiet icon-button" data-id="${x.id}" aria-label="Move ${esc(x.ssid)} down" ${index === w.length - 1 ? "disabled" : ""}`)}${button("Edit", "wifi-edit", `class="quiet edit-network" data-id="${x.id}"`)}<input type="checkbox" role="switch" data-toggle-wifi="${x.id}" aria-label="Enable ${esc(x.ssid)}" ${x.enabled ? "checked" : ""}>${button("Reconnect", "wifi-connect", `class="quiet" data-id="${x.id}" ${x.enabled ? "" : "disabled"}`)}${button("Remove", "wifi-remove", `class="quiet danger" data-id="${x.id}"`)}</div></div>`).join("")}</div><p class="help-text">Passwords stay on this device. Use arrows to change priority.</p>
      </details>
      <details class="settings-card"><summary>Remote access</summary>
        ${row("Remote access", `<input type="checkbox" role="switch" data-toggle-cloud aria-label="Enable remote access" ${i.cloud_enabled ? "checked" : ""}>`, "Your device initiates the secure connection")}
        ${row("Connection", `<span class="secondary" data-cloud-status>${esc(remoteStatus(n.cloud))}</span>`)}
        ${row("Registered name", `<span>${esc(n.registered_name || "Not registered yet")}</span>`)}
        ${row("Remote address", `<a href="${esc(i.server)}/?device=${encodeURIComponent(i.name)}" target="_blank" rel="noreferrer">${esc(i.server.replace(/^https?:\/\//, ""))}</a>`)}
        <details class="disclosure"><summary>Custom server</summary><form data-form="server">${field("server", "Server URL", i.server, "url", "required")}<div class="form-actions"><button>Save server</button></div></form></details>
      </details>
      <details class="settings-card"><summary>Security</summary>
        ${row("Administrator password", button("Change", "change-password"), "Verified only on this device")}
        ${row("Active sessions", button("Revoke all", "revoke"), "Sessions last 24 hours; settings access lasts 6 hours")}
        ${row("Identity recovery", button("Export recovery file", "identity-export"), "Keep the file private.")}
        ${row("Restore an identity", button("Restore…", "identity-restore"), "Requires your recovery file and a new password")}
      </details>
      <details class="settings-card"><summary>System</summary>
        ${row("Firmware", `<span class="mono">${esc(i.version)}</span>`)}
        ${row("Uptime", `<span class="mono">${Math.floor(h.uptime / 3600)}h ${Math.floor(h.uptime / 60) % 60}m</span>`)}
        ${row("Available memory", `<span class="mono">${h.free_memory ? Math.round(h.free_memory / 1024) + " KiB" : "Host managed"}</span>`)}
        ${row("Recorded errors", `<span>${h.errors}</span>`)}
        ${row("Factory reset", button("Erase device…", "reset", 'class="danger"'), "Export recovery first. Reserved names stay protected.")}
      </details>
    </div>`;
  }
  root.innerHTML = `<a class="skip-link" href="#main">Skip to content</a><div class="app-shell"><header class="app-topbar">${brand}<div class="app-device"><strong data-user-content>${esc(i.name)}</strong></div><div class="topbar-actions">${eventControl(i.event_mode)}${languageControl()}${button(icons.Settings + "<span>Settings</span>", "page", 'data-page="Settings" class="settings-trigger" aria-label="Settings"')}</div></header><main id="main" class="app-main"><header class="page-header"><div class="page-heading"><h1>Routing</h1></div></header><div class="page-body" id="control-host"></div></main>${page === "Settings" ? `<dialog class="dialog settings-dialog" id="settings-dialog" aria-label="Settings"><header class="dialog-header"><h2>Settings</h2>${button("×", "settings-close", 'class="quiet icon-button" aria-label="Close"')}</header><div class="dialog-body">${content}${button("Disconnect", "logout", 'class="quiet"')}</div></dialog>` : ""}</div>`;
  const cleanups = [
    mountControl(
      root.querySelector("#control-host"),
      client,
      "Routing",
      async () => {
        data.info = await client.call("device.info");
      },
    ),
  ];
  if (page === "Settings") {
    cleanups.push(
      mountControl(
        root.querySelector("#access-host"),
        client,
        "Access Control",
      ),
    );
    const settingsDialog = root.querySelector("#settings-dialog");
    settingsDialog.showModal();
    cleanups.push(installSettingsSidebar(settingsDialog, client));
    settingsDialog.addEventListener("cancel", (event) => {
      event.preventDefault();
      page = "Routing";
      render();
    });
    settingsDialog.addEventListener("click", (event) => {
      if (event.target === settingsDialog) {
        page = "Routing";
        render();
      }
    });
  }
  controlCleanup = () => cleanups.forEach((cleanup) => cleanup());
  root.querySelectorAll("[data-form]").forEach(
    (f) =>
      (f.onsubmit = (e) => {
        e.preventDefault();
        const v = Object.fromEntries(new FormData(f));
        run(() =>
          f.dataset.form === "server"
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
  if (d.action === "event-toggle") {
    d.element.disabled = true;
    try {
      await toggleEvent(client);
    } catch (error) {
      toast(error.message, "error", "event-mode");
    } finally {
      d.element.disabled = false;
    }
    return;
  }
  if (d.action === "settings-close") {
    if (!busy) {
      page = "Routing";
      render();
    }
    return;
  }
  if (d.action === "close-dialog") {
    if (!busy) closeDialog();
    return;
  }
  if (d.action === "page") {
    if (busy) return;
    page = d.page;
    window.scrollTo({ top: 0, behavior: "instant" });
    message = "";
    failure = "";
    if (page === "Settings") await refresh();
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
  if (d.action === "wifi-edit") {
    editWifi(data.wifi.find((x) => x.id === d.id));
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
document.addEventListener("change", (e) => {
  if (e.target.matches("[data-toggle-wifi]"))
    void run(() =>
      client.call("wifi.set_enabled", {
        id: e.target.dataset.toggleWifi,
        enabled: e.target.checked,
      }),
    );
  if (e.target.matches("[data-toggle-cloud]"))
    void run(async () => {
      const result = await settings({ cloud_enabled: e.target.checked });
      if (result?.reauthenticate)
        logout("Remote access updated. Reconnect to continue.", "success");
      else {
        message = e.target.checked
          ? "Remote access enabled."
          : "Remote access disabled.";
      }
    });
  if (e.target.matches("[data-available]"))
    dialog.querySelector("[name=ssid]").value = e.target.value;
});
document.addEventListener("drouter-info", (event) => {
  if (!client || restrictedCleanup) return;
  data.info = event.detail;
  const toggle = root.querySelector(".event-toggle");
  toggle?.setAttribute("aria-checked", !!data.info.event_mode);
});
// Update connection status without replacing an open settings dialog or its form values.
setInterval(() => {
  if (
    !client ||
    restrictedCleanup ||
    page !== "Settings" ||
    busy ||
    dialog ||
    document.querySelector(".control-dialog[open]") ||
    document.visibilityState !== "visible"
  )
    return;
  if (
    ![
      ...root.querySelectorAll("[data-cloud-status], [data-ethernet-status]"),
    ].some((el) => el.getClientRects().length)
  )
    return;
  const session = client;
  void session
    .call("network.status")
    .then((network) => {
      if (session !== client || page !== "Settings") return;
      data.network = network;
      const cloud = root.querySelector("[data-cloud-status]");
      if (cloud) cloud.textContent = remoteStatus(network.cloud);
      const ethernet = root.querySelector("[data-ethernet-status]");
      if (ethernet)
        ethernet.innerHTML = status(
          network.ethernet.link,
          network.ethernet.ip || "Disconnected",
        );
      for (const profile of data.wifi) {
        const item = [...root.querySelectorAll("[data-wifi]")].find(
          (el) => el.dataset.wifi === profile.id,
        );
        const state = item?.querySelector(".wifi-copy .secondary");
        if (state)
          state.textContent =
            network.wifi.connected && network.wifi.active === profile.id
              ? "Connected"
              : profile.enabled
                ? "Saved"
                : "Disabled";
      }
    })
    .catch(() => {});
}, 10000);
fetch("/bootstrap")
  .then((r) => r.json())
  .then(async (b) => {
    if (b.setup) return setup();
    root.innerHTML =
      '<p class="loading-state" role="status">Restoring session…</p>';
    const resumed = await Client.restore({ remote: false });
    if (!resumed) return login();
    try {
      await acceptClient(resumed);
    } catch {
      resumed.close();
      client = null;
      login();
    }
  })
  .catch((e) => {
    root.textContent = e.message;
  });

installLocalization();
installActivity();
