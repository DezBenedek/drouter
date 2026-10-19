import { Client, randomId } from "./shared/client.js";
const root = document.querySelector("#app");
const esc = (s) =>
  String(s ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
let client,
  page = "Dashboard",
  data = {},
  message = "",
  error = "",
  busy = false,
  editingWifi = null;
const tabs = ["Dashboard", "Routing", "Devices", "Presets", "Settings"];
const input = (name, label, value = "", type = "text", required = false) =>
  `<label>${label}<input name="${name}" type="${type}" value="${esc(value)}" ${required ? "required" : ""}></label>`;
const badge = (ok, text) =>
  `<span class="badge ${ok ? "" : "off"}">${esc(text)}</span>`;
async function run(action) {
  if (busy) return;
  busy = true;
  error = "";
  render();
  try {
    await action();
    await refresh();
  } catch (e) {
    error = e.message;
    try {
      await refresh();
    } catch {}
  } finally {
    busy = false;
    render();
  }
}
async function refresh() {
  if (!client) return;
  const [info, health, network, receivers, sources, presets, wifi] =
    await Promise.all(
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
    info,
    health,
    network,
    receivers,
    sources: sources.sources,
    sourceErrors: sources.errors,
    presets,
    wifi,
  };
}
function login(setup = false) {
  root.innerHTML = `<div class="login"><aside class="login-art"><div class="brand"><span class="brand-mark">↔</span> DRouter</div><div><div class="eyebrow">Standalone NDI control</div><h1>Your sources.<br>Your network.<br>One place.</h1><p>Route BirdDog receivers, save your presets, and stay in control. Everything lives on this device.</p><div class="route-art">${"<span></span>".repeat(20)}</div></div><small>Local control · Cloud optional</small></aside><main class="login-panel"><form class="login-form"><div class="eyebrow">${setup ? "First-time setup" : "Local device"}</div><h1>${setup ? "Make it yours." : "Welcome back."}</h1><p>${setup ? "Use the provisioning token shown over USB serial." : "Connect with your device administrator password."}</p><div id="login-error" class="notice error" hidden></div>${setup ? input("token", "Physical provisioning token", "", "text", true) + input("name", "Device name", "studio-router", "text", true) : ""}${input("password", "Administrator password", "", "password", true)}${setup ? `<small>Use at least 12 characters.</small>${input("ssid", "Wi-Fi SSID (optional)")}${input("wifi_password", "Wi-Fi password", "", "password")}<details><summary>Ethernet static IP (optional)</summary>${input("address", "IPv4 address")}${input("mask", "Subnet mask")}${input("gateway", "Gateway")}${input("dns", "DNS")}</details><label class="check"><input name="cloud" type="checkbox">Enable optional Cloud access</label>` : ""}<button class="primary">${setup ? "Set up device" : "Connect"} →</button><p><small>${setup ? "Ethernet uses DHCP when static fields are empty." : "Your password is verified by this device."}</small></p></form></main></div>`;
  root.querySelector("form").onsubmit = async (e) => {
    e.preventDefault();
    const form = e.currentTarget,
      f = new FormData(form);
    const button = form.querySelector("button");
    button.disabled = true;
    try {
      if (setup) {
        if (String(f.get("password")).length < 12)
          throw new Error("Use at least 12 characters");
        const ethernet = Object.fromEntries(
          ["address", "mask", "gateway", "dns"].map((k) => [
            k,
            f.get(k) || null,
          ]),
        );
        const response = await fetch("/setup", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            token: f.get("token"),
            name: f.get("name"),
            password: f.get("password"),
            ethernet,
            cloud_enabled: f.has("cloud"),
            wifi: f.get("ssid")
              ? {
                  id: randomId(),
                  ssid: f.get("ssid"),
                  password: f.get("wifi_password"),
                }
              : null,
          }),
        });
        const result = await response.json();
        if (!response.ok) throw new Error(result.error);
        message = `Device configured. Remote name: ${result.remote_name}`;
      }
      client = new Client();
      await client.open("", String(f.get("password")), false);
      client.onDisconnect = () => {
        client = null;
        data = {};
        login();
        const notice = root.querySelector("#login-error");
        if (notice) {
          notice.hidden = false;
          notice.textContent =
            "Device unavailable or session expired. Reconnect to continue.";
        }
      };
      form.reset();
      await refresh();
      render();
    } catch (e) {
      const notice = root.querySelector("#login-error");
      notice.hidden = false;
      notice.textContent = e.message;
    } finally {
      button.disabled = false;
    }
  };
}
function render() {
  if (!client || !data.info) return;
  const {
    info: i,
    health: h,
    network: n,
    receivers: r,
    sources: s,
    presets: p,
    wifi: w,
  } = data;
  let content = "";
  if (page === "Dashboard")
    content = `<div class="stats">${[
      [
        "BirdDog receivers",
        `${r.filter((x) => x.state.online).length}/${r.length}`,
        "Online / registered outputs",
      ],
      ["NDI sources", s.length, "Available on receivers"],
      ["Uptime", `${Math.floor(h.uptime / 60)}m`, "Since last boot"],
      [
        "Memory",
        h.free_memory
          ? `${Math.round(h.free_memory / 1024)} KiB`
          : "Host managed",
        "Available heap",
      ],
    ]
      .map(
        ([a, b, c]) =>
          `<div class="card"><small>${a}</small><div class="stat-value">${b}</div><small>${c}</small></div>`,
      )
      .join(
        "",
      )}</div><div class="grid"><section class="card"><h2>Network overview</h2><div class="row">Ethernet ${badge(n.ethernet.link, n.ethernet.link ? n.ethernet.ip : "Disconnected")}</div><div class="row">Wi-Fi ${badge(n.wifi.connected, n.active_ssid || "Disconnected")}</div><div class="row">Cloud access ${badge(n.cloud === "connected", n.cloud)}</div></section><section class="card"><h2>This device</h2><div class="row">Name <b>${esc(i.name)}</b></div><div class="row">Firmware <span>${esc(i.version)}</span></div><div class="row">Errors <span>${h.errors}</span></div><p><small>Cloud access is optional. Routing runs locally.</small></p></section></div>`;
  if (page === "Routing")
    content = `<section class="card"><div class="header-row"><div><h2>Routing matrix</h2><small>Select a source for each output. Changes are verified on the receiver.</small></div><button data-action="refresh-sources">Refresh sources</button></div>${!r.length ? '<div class="empty">Add a BirdDog receiver in Devices to start routing.</div>' : `<div class="table-scroll"><table><thead><tr><th>Output / Source</th>${s.map((x) => `<th>${esc(x.name)}</th>`).join("")}</tr></thead><tbody>${r.map((x) => `<tr><td><b>${esc(x.config.label)}</b><br><small>${esc(x.state.error || x.state.source || "No source")}</small></td>${s.map((y) => `<td><button class="matrix ${x.state.source === y.name ? "selected" : ""}" data-action="route" data-receiver="${esc(x.config.id)}" data-source="${esc(y.name)}" ${!x.state.online || busy ? "disabled" : ""} aria-label="Route ${esc(y.name)} to ${esc(x.config.label)}">${x.state.source === y.name ? "✓" : "+"}</button></td>`).join("")}</tr>`).join("")}</tbody></table></div><div class="matrix-legend"><span class="dot"></span>Verified active source</div>`}</section>`;
  if (page === "Devices")
    content = `<div class="grid"><section class="card"><h2>BirdDog receivers</h2>${r.map((x) => `<div class="row"><div><b>${esc(x.config.label)}</b><br><small>${x.config.ip}:${x.config.port} · API 2.0</small><br>${badge(x.state.online, x.state.online ? "Online" : "Offline")}</div><div class="actions"><button data-action="rename-receiver" data-id="${esc(x.config.id)}">Rename</button><button data-action="remove-receiver" data-id="${esc(x.config.id)}">Remove</button></div></div>`).join("") || "<p>No receivers registered.</p>"}<button data-action="discover">Detect devices</button></section><form class="card" data-form="receiver"><h2>Add a receiver</h2>${input("label", "Label", "", "text", true)}${input("ip", "IPv4 address", "", "text", true)}${input("port", "API port", "8080", "number", true)}${input("channel", "Channel", "1", "number", true)}<button class="primary">Add receiver</button></form></div>`;
  if (page === "Presets")
    content = `<div class="grid"><section class="card"><h2>Saved presets</h2>${p.map((x) => `<div class="row"><div><b>${esc(x.name)}</b><br><small>${x.routes.length} outputs</small></div><div class="actions"><button class="primary" data-action="apply-preset" data-id="${x.id}">Apply</button><button data-action="rename-preset" data-id="${x.id}">Rename</button><button data-action="delete-preset" data-id="${x.id}">Delete</button></div></div>`).join("") || "<p>No presets yet.</p>"}</section><form class="card" data-form="preset"><h2>Save current routing</h2><p>Capture the actual sources reported by all receivers.</p>${input("name", "Preset name", "", "text", true)}<button class="primary">Save preset</button></form></div>`;
  if (page === "Settings")
    content = `<div class="grid"><form class="card" data-form="settings"><h2>Device & remote access</h2>${input("name", "Device name", i.name)}${input("password", "New password (leave empty to keep)", "", "password")}<label class="check"><input type="checkbox" name="cloud" ${i.cloud_enabled ? "checked" : ""}>Enable Cloud access</label><p><small>Remote name<br><b>${esc(i.remote_name)}</b></small></p><details><summary>Advanced server override</summary>${input("server", "Server URL", i.server)}</details><button class="primary">Save settings</button></form><section class="card"><h2>Saved Wi-Fi networks</h2><p><small>Top to bottom priority. Preferred networks need two stable scans.</small></p>${w.map((x, index) => `<div class="row"><div><small>${index + 1}.</small> <b>${esc(x.ssid)}</b></div><div class="actions"><button data-action="wifi-up" data-id="${x.id}" ${index === 0 ? "disabled" : ""}>↑</button><button data-action="wifi-connect" data-id="${x.id}">Connect</button><button data-action="wifi-edit" data-id="${x.id}">Edit</button><button data-action="wifi-remove" data-id="${x.id}">×</button></div></div>`).join("")}<form data-form="wifi">${input("ssid", "SSID", editingWifi?.ssid || "", "text", true)}${input("password", "Wi-Fi password", "", "password", true)}<button>${editingWifi ? "Save network" : "Add network"}</button></form></section><form class="card" data-form="ethernet"><h2>Ethernet</h2><p><small>Leave the address empty for DHCP. Applied without reflashing.</small></p>${["address", "mask", "gateway", "dns"].map((k) => input(k, { address: "IPv4 address", mask: "Subnet mask", gateway: "Gateway", dns: "DNS" }[k], i.ethernet_config[k] || "")).join("")}<button>Save Ethernet</button></form><section class="card"><form data-form="policy"><h2>Wi-Fi priority policy</h2>${input("preferred", "Preferred scan interval (60–3600 seconds)", i.wifi_policy.preferred_check_secs, "number")}${input("retry", "Retry interval (5–120 seconds)", i.wifi_policy.retry_secs, "number")}<label class="check"><input type="checkbox" name="prefer" ${i.wifi_policy.prefer_higher ? "checked" : ""}>Prefer higher priority networks</label><button>Save policy</button></form><div class="section-label">Security</div><div class="actions"><button data-action="revoke">Revoke all sessions</button><button class="danger" data-action="reset">Factory reset</button></div></section></div>`;
  root.innerHTML = `<div class="app"><aside class="sidebar"><div class="brand"><span class="brand-mark">↔</span> DRouter</div><div class="muted">${esc(i.name)}<br>Local control</div><nav class="nav">${tabs.map((t) => `<button data-page="${t}" class="${page === t ? "active" : ""}">${t}</button>`).join("")}</nav><div class="sidebar-foot">DEVICE-OWNED DATA<br>Firmware ${esc(i.version)}<br><button data-action="logout">Disconnect</button></div></aside><main class="main"><header class="topbar"><span class="muted">Workspace / ${page}</span>${badge(true, "Local device connected")}</header><div class="header-row"><div><div class="eyebrow">Your NDI workspace</div><h1>${page}</h1><p>${page === "Dashboard" ? "Everything you need, right on your network." : "Control your connected BirdDog devices."}</p></div><button data-action="refresh">Refresh</button></div>${error ? `<div class="notice error">${esc(error)}</div>` : ""}${message ? `<div class="notice">${esc(message)}</div>` : ""}${busy ? '<p class="progress">Operation pending · waiting for device confirmation…</p>' : ""}${content}</main></div>`;
  root.querySelectorAll("[data-page]").forEach(
    (b) =>
      (b.onclick = () => {
        page = b.dataset.page;
        message = "";
        render();
      }),
  );
  root
    .querySelectorAll("[data-action]")
    .forEach((b) => (b.onclick = () => action(b.dataset)));
  root.querySelectorAll("[data-form]").forEach(
    (f) =>
      (f.onsubmit = (e) => {
        e.preventDefault();
        const values = Object.fromEntries(new FormData(f));
        run(async () => {
          if (f.dataset.form === "receiver")
            await client.call("receivers.add", {
              id: randomId(),
              label: values.label,
              ip: values.ip,
              port: +values.port,
              channel: +values.channel,
            });
          if (f.dataset.form === "preset")
            await client.call("presets.create", { name: values.name });
          if (f.dataset.form === "wifi") {
            await client.call("wifi.add", {
              id: editingWifi?.id || randomId(),
              ssid: values.ssid,
              password: values.password,
            });
            editingWifi = null;
          }
          if (f.dataset.form === "settings") {
            await client.call("settings.update", {
              expected_revision: i.revision,
              name: values.name,
              cloud_enabled: !!values.cloud,
              server: values.server,
              ...(values.password ? { password: values.password } : {}),
            });
            client.close();
            client = null;
            data = {};
            login();
            return;
          }
          if (f.dataset.form === "ethernet")
            await client.call("settings.update", {
              expected_revision: i.revision,
              ethernet: Object.fromEntries(
                ["address", "mask", "gateway", "dns"].map((k) => [
                  k,
                  values[k] || null,
                ]),
              ),
            });
          if (f.dataset.form === "policy")
            await client.call("settings.update", {
              expected_revision: i.revision,
              wifi_policy: {
                preferred_check_secs: +values.preferred,
                retry_secs: +values.retry,
                prefer_higher: !!values.prefer,
              },
            });
          message = "Saved on this device.";
        });
      }),
  );
}
function action(d) {
  if (d.action === "wifi-edit") {
    editingWifi = data.wifi.find((w) => w.id === d.id);
    render();
    return;
  }
  if (d.action === "logout") {
    client.close();
    client = null;
    data = {};
    login();
    return;
  }
  run(async () => {
    if (d.action === "route")
      await client.call("route.set", {
        receiver: d.receiver,
        source: d.source,
      });
    if (d.action === "refresh-sources") await client.call("sources.refresh");
    if (d.action === "remove-receiver")
      await client.call("receivers.remove", { id: d.id });
    if (d.action === "rename-receiver" || d.action === "rename-preset") {
      const name = prompt("New name");
      if (name)
        await client.call(
          d.action === "rename-receiver"
            ? "receivers.rename"
            : "presets.update",
          { id: d.id, name },
        );
    }
    if (d.action === "discover") {
      const found = await client.call("receivers.discover");
      for (const receiver of found)
        await client.call("receivers.add", receiver);
      message = found.length
        ? `Added ${found.length} verified receivers.`
        : "No verified receivers found. You can add a device by IP.";
    }
    if (d.action === "apply-preset") {
      const result = await client.call("presets.apply", { id: d.id });
      message = result.results
        .map((x) => `${x.receiver}: ${x.ok ? "Verified" : x.error}`)
        .join("\n");
    }
    if (d.action === "delete-preset")
      await client.call("presets.delete", { id: d.id });
    if (d.action === "wifi-remove")
      await client.call("wifi.remove", { id: d.id });
    if (d.action === "wifi-connect")
      await client.call("wifi.connect", { id: d.id });
    if (d.action === "wifi-up") {
      const ids = data.wifi.map((w) => w.id);
      const i = ids.indexOf(d.id);
      [ids[i - 1], ids[i]] = [ids[i], ids[i - 1]];
      await client.call("wifi.reorder", { ids });
    }
    if (d.action === "revoke" || d.action === "reset") {
      if (
        d.action === "reset" &&
        !confirm(
          "Erase all device settings and identity? Physical provisioning will be required.",
        )
      )
        return;
      await client.call(
        d.action === "reset" ? "factory.reset" : "sessions.revoke",
      );
      client.close();
      client = null;
      data = {};
      login(d.action === "reset");
    }
  });
}
fetch("/bootstrap")
  .then((r) => r.json())
  .then((b) => login(b.setup))
  .catch((e) => {
    root.textContent = e.message;
  });
