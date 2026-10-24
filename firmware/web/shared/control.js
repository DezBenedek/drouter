import { randomId } from "./client.js";
import { t, languageControl, localize } from "./i18n.js";
// React can install Sonner without adding its runtime to the embedded UI.
let toastAdapter;
export function setToastAdapter(adapter) {
  toastAdapter = adapter;
}
// Shared notifications for the standalone ESP32 interface.
let toaster;
const notifications = new Map();
function placeToaster() {
  if (!toaster || !notifications.size) return;
  const target =
    [...document.querySelectorAll("dialog[open]")].at(-1) || document.body;
  if (toaster.parentElement !== target) {
    if (toaster.showPopover && toaster.matches(":popover-open"))
      toaster.hidePopover();
    target.append(toaster);
  }
  // Keep the open mobile navigation panel usable as well as the tab bar.
  const menu =
    innerWidth < 900 && target === document.body
      ? document.querySelector(".more-menu")?.getBoundingClientRect()
      : null;
  toaster.style.bottom = menu?.height ? `${innerHeight - menu.top + 12}px` : "";
  if (toaster.showPopover && !toaster.matches(":popover-open"))
    toaster.showPopover();
}
export function dismissToast(id = "") {
  if (toastAdapter) return toastAdapter.dismiss(id);
  for (const [key, item] of notifications) {
    if (id && key !== id) continue;
    clearTimeout(item.timer);
    item.element.remove();
    notifications.delete(key);
  }
  if (!notifications.size && toaster) {
    if (toaster.showPopover && toaster.matches(":popover-open"))
      toaster.hidePopover();
    // Release a dialog/form ancestor as soon as its last notification goes away.
    toaster.remove();
  }
}
export function toast(message, kind = "info", id = "") {
  if (!message) return;
  if (toastAdapter) return toastAdapter.show(message, kind, id);
  if (!toaster) {
    toaster = document.createElement("section");
    toaster.className = "toast-region";
    toaster.setAttribute("aria-label", t("Notifications"));
    if (toaster.showPopover) toaster.setAttribute("popover", "manual");
    // Native modal dialogs form a top layer. Keep notifications visible and
    // accessible there, then return them to the app when the dialog closes.
    document.addEventListener("close", placeToaster, true);
    new MutationObserver((records) => {
      if (
        records.some(
          (record) =>
            record.target.tagName === "DIALOG" ||
            record.target.classList?.contains("more-menu") ||
            [...record.addedNodes, ...record.removedNodes].some((node) =>
              node.classList?.contains("more-menu"),
            ),
        )
      )
        placeToaster();
    }).observe(document.body, {
      subtree: true,
      attributes: true,
      childList: true,
      attributeFilter: ["open", "hidden"],
    });
    window.addEventListener("resize", placeToaster);
    document.addEventListener("drouter-language", () => {
      toaster.setAttribute("aria-label", t("Notifications"));
    });
  }
  const key = id || randomId();
  let item = notifications.get(key);
  if (!item) {
    if (notifications.size >= 3)
      dismissToast(notifications.keys().next().value);
    const element = document.createElement("div");
    element.className = "toast";
    element.innerHTML = `<span class="toast-icon" aria-hidden="true"></span><div class="toast-copy"></div><button type="button" class="toast-close" aria-label="${t("Dismiss notification")}">×</button>`;
    item = { element, timer: null, kind };
    notifications.set(key, item);
    const current = item;
    element.querySelector("button").onclick = () => dismissToast(key);
    element.addEventListener("pointerenter", () => clearTimeout(current.timer));
    element.addEventListener("focusin", () => clearTimeout(current.timer));
    const resume = () => {
      clearTimeout(current.timer);
      if (
        current.kind !== "loading" &&
        !element.matches(":hover,:focus-within")
      )
        current.timer = setTimeout(
          () => dismissToast(key),
          current.kind === "error" ? 10000 : 5000,
        );
    };
    element.addEventListener("pointerleave", resume);
    element.addEventListener("focusout", resume);
    toaster.append(element);
  }
  clearTimeout(item.timer);
  item.kind = kind;
  item.element.dataset.kind = kind;
  item.element.setAttribute("role", kind === "error" ? "alert" : "status");
  item.element.setAttribute("aria-atomic", "true");
  item.element.querySelector(".toast-copy").textContent = t(message);
  item.element.querySelector(".toast-icon").innerHTML =
    kind === "loading"
      ? '<span class="spinner"></span>'
      : `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="12" cy="12" r="9"/>${kind === "success" ? '<path d="m8 12 3 3 5-6"/>' : kind === "error" ? '<path d="M12 7v6m0 3v1"/>' : '<path d="M12 10v7m0-11v1"/>'}</svg>`;
  placeToaster();
  localize(toaster);
  if (kind !== "loading" && !item.element.matches(":hover,:focus-within"))
    item.timer = setTimeout(
      () => dismissToast(key),
      kind === "error" ? 10000 : 5000,
    );
  return key;
}
export const escapeHtml = (s) =>
  String(s ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
const e = escapeHtml;
const b = (label, action, attrs = "") =>
  `<button type="button" data-control="${e(action)}" ${attrs}>${attrs.includes("data-user-content") ? label : t(label)}</button>`;
const field = (label, name, value = "", extra = "") =>
  `<label class="field">${t(label)}<input name="${name}" value="${e(value)}" ${extra}></label>`;
const empty = (label) => `<p class="empty-state">${t(label)}</p>`;
const labelFor = (data, source) =>
  data.saved.find((s) => s.source === source)?.display_name ||
  source ||
  t("No source");
function dialog(title, body, submit, action = "Save") {
  const previous = document.activeElement;
  let submitting = false;
  const d = document.createElement("dialog");
  d.className = "dialog control-dialog";
  d.setAttribute("aria-label", t(title));
  d.innerHTML = `<form><header class="dialog-header"><h2>${t(title)}</h2>${b('<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path d="m6 6 12 12M6 18 18 6"/></svg>', "close", `class="quiet icon-button" aria-label="${t("Close")}"`)}</header><div class="dialog-body">${body}</div><footer class="dialog-footer">${b("Cancel", "close")}<button class="primary">${t(action)}</button></footer></form>`;
  d.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      event.preventDefault();
      if (!submitting) d.close();
    }
  });
  d.addEventListener("click", (event) => {
    if (event.target === d && !submitting) d.close();
  });
  document.body.append(d);
  d.querySelectorAll("[data-control=close]").forEach(
    (x) =>
      (x.onclick = () => {
        if (!submitting) d.close();
      }),
  );
  d.addEventListener("cancel", (event) => {
    event.preventDefault();
    if (!submitting) d.close();
  });
  d.addEventListener("close", () => {
    d.remove();
    if (previous?.isConnected) previous.focus();
  });
  d.querySelector("form").onsubmit = async (event) => {
    event.preventDefault();
    if (submitting) return;
    submitting = true;
    const buttons = [...d.querySelectorAll("button")].map((x) => [
      x,
      x.disabled,
    ]);
    buttons.forEach(([x]) => (x.disabled = true));
    try {
      await submit(new FormData(event.currentTarget), d);
    } catch (error) {
      toast(error.message, "error", "form-error");
    } finally {
      submitting = false;
      buttons.forEach(([x, wasDisabled]) => (x.disabled = wasDisabled));
    }
  };
  localize(d);
  d.showModal();
  return d;
}
export function confirmChange(title, body, perform = async () => {}) {
  return new Promise((resolve) => {
    const d = dialog(
      title,
      `<p>${e(t(body))}</p>`,
      async (_, d) => {
        await perform();
        resolve(true);
        d.close();
      },
      "Confirm",
    );
    d.addEventListener("close", () => resolve(false));
  });
}
export function publishInfo(info) {
  document.dispatchEvent(new CustomEvent("drouter-info", { detail: info }));
}
export async function toggleEvent(client) {
  const info = await client.call("device.info");
  const enabled = info.event_mode;
  let next;
  await confirmChange(
    enabled ? "Disable Event Mode" : "Enable Event Mode",
    enabled
      ? "Disable Event Mode? Simple Modes will become available again."
      : "Enabling Event Mode will temporarily disable all Simple Modes. Only the administrator will be able to control DRouter.",
    async () => {
      await client.call(enabled ? "event.disable" : "event.enable", {
        confirmed: true,
        expected_revision: info.revision,
      });
      next = await client.call("device.info");
      publishInfo(next);
      toast(
        next.event_mode ? "Event Mode enabled" : "Event Mode disabled",
        "success",
        "event-mode",
      );
    },
  );
  return next;
}
export function eventControl(enabled) {
  return `<button type="button" class="event-toggle" data-action="event-toggle" role="switch" aria-checked="${!!enabled}" aria-label="${t("Event Mode")}"><span>${t("Event Mode")}</span><span class="switch-track" aria-hidden="true"></span></button>`;
}
const settingsSections = [
  "Simple Mode",
  "Device",
  "Network",
  "Remote access",
  "Security",
  "System",
];
const settingsSelection = new WeakMap();
let activityState = {
  title: "Ready",
  detail: "",
  current: 0,
  total: 0,
  kind: "idle",
  time: Date.now(),
};
let activitySerial = 0;
const activityHistory = [];
const activityTasks = new Map();
function renderActivity() {
  for (const host of document.querySelectorAll("[data-activity-host]")) {
    if (!host.querySelector(".activity-current"))
      host.innerHTML =
        '<div class="activity-current" role="status" aria-live="polite"><span class="activity-light" aria-hidden="true"></span><time></time><strong data-user-content></strong><span class="activity-detail" data-user-content></span></div>';
    host.dataset.kind = activityState.kind;
    host.querySelector("time").textContent = new Date(
      activityState.time,
    ).toLocaleTimeString([], { hour12: false });
    host.querySelector("strong").textContent =
      t(activityState.title) +
      (activityState.total
        ? ` (${activityState.current}/${activityState.total})`
        : "");
    host.querySelector(".activity-detail").textContent = t(
      activityState.detail,
    );
  }
  const history = document.querySelector(".activity-history-list");
  if (history)
    history.innerHTML = activityHistory
      .slice(-30)
      .reverse()
      .map(
        (entry) =>
          `<div data-kind="${entry.kind}"><time>${new Date(entry.time).toLocaleTimeString([], { hour12: false })}</time><span data-user-content>${e(t(entry.title))}${entry.total ? ` (${entry.current}/${entry.total})` : ""} · ${e(t(entry.detail))}</span></div>`,
      )
      .join("");
}
export function beginTask(title, total = 0) {
  const serial = ++activitySerial;
  let ownState = {
    title,
    total,
    current: 0,
    detail: "",
    kind: "running",
    time: Date.now(),
  };
  const update = (kind, current, detail) => {
    ownState = { title, total, current, detail, kind, time: Date.now() };
    if (kind === "running") activityTasks.set(serial, ownState);
    else activityTasks.delete(serial);
    activityState = [...activityTasks.values()].at(-1) || ownState;
    activityHistory.push({ ...ownState });
    if (activityHistory.length > 30) activityHistory.shift();
    renderActivity();
  };
  update("running", 0, "");
  return {
    setTotal(value) {
      total = value;
      update("running", 0, ownState.detail);
    },
    step(current, detail) {
      update("running", current, detail);
    },
    done(detail = t("Completed")) {
      update("done", total, detail);
    },
    fail(detail) {
      update("error", ownState.current, detail);
    },
  };
}
export function installActivity() {
  if (document.querySelector(".activity-bar")) return;
  const bar = document.createElement("div");
  bar.className = "activity-bar";
  bar.innerHTML = `<div data-activity-host></div><details class="activity-history"><summary>${t("Activity log")}</summary><div class="activity-history-list" role="log" aria-live="off"></div></details>`;
  document.body.prepend(bar);
  document.body.classList.add("with-activity");
  document.addEventListener("drouter-language", renderActivity);
  renderActivity();
}
function dialogActivity(dialog) {
  if (dialog.querySelector("[data-activity-host]")) return;
  const line = document.createElement("div");
  line.className = "activity-inline";
  line.setAttribute("data-activity-host", "");
  dialog.querySelector(".dialog-body").before(line);
  renderActivity();
}
function controlsChanged(client) {
  document.dispatchEvent(
    new CustomEvent("drouter-controls-refresh", { detail: { client } }),
  );
}
export function installSettingsSidebar(dialog, client) {
  dialog.classList.add("sidebar-dialog", "settings-dialog");
  const body = dialog.querySelector(".dialog-body");
  body.classList.add("settings-dialog-layout");
  const panes = [...body.querySelectorAll(".settings-single > .settings-card")];
  const nav = document.createElement("nav");
  nav.className = "dialog-sidebar";
  nav.setAttribute("aria-label", t("Settings sections"));
  nav.innerHTML = `<span class="sidebar-caption">DRouter</span>${panes.map((pane, index) => `<button type="button" data-settings-section="${index}">${t(settingsSections[index] || "Device")}</button>`).join("")}<div class="sidebar-divider"></div><button type="button" data-settings-logout class="sidebar-logout">${t("Disconnect")}</button>`;
  body.prepend(nav);
  const logout = body.querySelector(
    '.settings-logout-action, [data-action="logout"]',
  );
  if (logout) logout.hidden = true;
  panes.forEach((pane, index) => {
    pane.dataset.settingsPane = String(index);
    if (pane.tagName === "DETAILS") {
      pane.open = true;
      const heading = document.createElement("h2");
      heading.className = "settings-panel-title";
      heading.textContent = t(settingsSections[index] || "Device");
      pane.prepend(heading);
    }
  });
  const select = (index) => {
    const selected = Math.min(Math.max(0, index), panes.length - 1);
    settingsSelection.set(client, selected);
    panes.forEach((pane, i) => {
      pane.hidden = i !== selected;
    });
    nav.querySelectorAll("[data-settings-section]").forEach((button) => {
      if (Number(button.dataset.settingsSection) === selected)
        button.setAttribute("aria-current", "page");
      else button.removeAttribute("aria-current");
    });
  };
  nav.onclick = (event) => {
    const button = event.target.closest("button");
    if (!button) return;
    if (button.hasAttribute("data-settings-section"))
      select(Number(button.dataset.settingsSection));
    if (button.hasAttribute("data-settings-logout")) logout?.click();
  };
  select(settingsSelection.get(client) || 0);
  dialogActivity(dialog);
  localize(nav);
  return () => nav.remove();
}
export async function resetNdiLists(client, receiver = null) {
  const task = beginTask("NDI list reset");
  task.step(0, t("Reading device list"));
  const devices = receiver
    ? [receiver]
    : (
        await client.call("receivers.list").catch((error) => {
          task.fail(t(error.message));
          throw error;
        })
      ).map((r) => r.config);
  task.setTotal(devices.length);
  const errors = [];
  for (let i = 0; i < devices.length; i++) {
    const device = devices[i];
    task.step(
      i + 1,
      `${device.label} · ${t("Clearing cached sources and discovering active NDI sources")}`,
    );
    try {
      await client.call("birddog.sources.reset", { id: device.id });
    } catch (error) {
      errors.push(`${device.label}: ${t(error.message)}`);
    }
  }
  controlsChanged(client);
  if (errors.length) {
    task.fail(errors.join(" · "));
    toast(errors.join("\n"), "error");
  } else {
    task.done(t("Active NDI source lists loaded"));
    toast("Active NDI source lists loaded", "success");
  }
}
export async function autoFix(client, actions = null) {
  const task = beginTask("Auto bugfix");
  task.step(0, t("Reading device list"));
  const receivers = actions
    ? [
        ...new Map(
          actions.map((a) => [a.receiver, { id: a.receiver, label: a.label }]),
        ).values(),
      ]
    : (
        await client.call("receivers.list").catch((error) => {
          task.fail(t(error.message));
          throw error;
        })
      ).map((r) => r.config);
  if (!receivers.length) {
    task.done(t("No receivers to check."));
    toast("No receivers to check.");
    return;
  }
  const failures = [];
  const steps = 6;
  task.setTotal(receivers.length * steps);
  toast("Auto bugfix running…", "loading", "autofix");
  for (let index = 0; index < receivers.length; index++) {
    const receiver = receivers[index];
    const op = actions ? "simple.repair" : "route.repair";
    try {
      task.step(
        index * steps + 1,
        `${receiver.label} · ${t("Starting receiver diagnostics")}`,
      );
      let result = await client.call(op, { id: receiver.id, staged: true });
      while (!result.done) {
        task.step(
          index * steps + result.completed + 1,
          `${receiver.label} · ${t(result.next)}`,
        );
        result = await client.call(op, {
          id: receiver.id,
          token: result.token,
        });
      }
      task.step(
        (index + 1) * steps,
        `${receiver.label} · ${t("Routing verified")}${result.notes.length ? " · " + result.notes.map((note) => t(note)).join(" · ") : ""}`,
      );
    } catch (error) {
      failures.push(`${receiver.label}: ${t(error.message)}`);
      task.step((index + 1) * steps, failures.at(-1));
    }
  }
  controlsChanged(client);
  if (failures.length) task.fail(failures.join(" · "));
  else task.done(t("Auto bugfix complete. Routes verified."));
  toast(
    failures.length
      ? `${t("Some receivers could not be repaired.")}\n${failures.join("\n")}`
      : "Auto bugfix complete. Routes verified.",
    failures.length ? "error" : "success",
    "autofix",
  );
}
const routeCache = new WeakMap();
const receiverFocusCache = new WeakMap();
const currentSource = (r) =>
  r.state.online ? r.state.source : r.state.last_source;
async function load(client, page) {
  const access = page === "Access Control";
  const ops = access
    ? [
        "device.info",
        "simple.list",
        "sources.saved.list",
        "sources.list",
        "receivers.list",
      ]
    : [
        "device.info",
        "sources.saved.list",
        "sources.list",
        "receivers.list",
        ...(page === "Simple Modes" ? ["simple.list"] : []),
      ];
  const results = await Promise.all(ops.map((op) => client.call(op)));
  const info = results[0];
  const saved = access ? (results[2] ?? []) : (results[1] ?? []);
  const discovered = access
    ? (results[3] ?? { sources: [] })
    : (results[2] ?? { sources: [] });
  const receivers = access ? (results[4] ?? []) : (results[3] ?? []);
  const profiles = access ? (results[1] ?? []) : (results[4] ?? []);
  publishInfo(info);
  let cache = routeCache.get(client);
  if (!cache) {
    cache = new Map();
    routeCache.set(client, cache);
  }
  for (const receiver of receivers)
    receiver.state.last_source =
      receiver.state.source || cache.get(receiver.config.id) || null;
  return {
    info,
    saved,
    sources: discovered.sources,
    sourceErrors: discovered.errors || [],
    receivers,
    profiles,
    event: { enabled: info.event_mode },
  };
}
function controlKey(node) {
  if (node.nodeType !== 1) return "";
  return (
    node.getAttribute("data-key") ||
    node.getAttribute("data-focus") ||
    (node.hasAttribute("data-control")
      ? `${node.getAttribute("data-control")}:${node.getAttribute("data-id") || ""}`
      : "")
  );
}
function patchControl(parent, nextParent) {
  let cursor = parent.firstChild;
  for (const desired of [...nextParent.childNodes]) {
    const key = controlKey(desired);
    let current = cursor;
    if (key && (!current || controlKey(current) !== key)) {
      current = [...parent.childNodes].find(
        (node) =>
          node.nodeName === desired.nodeName && controlKey(node) === key,
      );
      if (current) parent.insertBefore(current, cursor);
    }
    if (
      !current ||
      current.nodeName !== desired.nodeName ||
      controlKey(current) !== key
    ) {
      current = desired.cloneNode(true);
      parent.insertBefore(current, cursor);
    } else if (current.nodeType === 3) {
      if (current.data !== desired.data) current.data = desired.data;
    } else if (current.nodeType === 1) {
      for (const attribute of [...current.attributes]) {
        if (
          !desired.hasAttribute(attribute.name) &&
          !attribute.name.startsWith("data-i18n-")
        )
          current.removeAttribute(attribute.name);
      }
      for (const attribute of [...desired.attributes]) {
        if (current.getAttribute(attribute.name) !== attribute.value)
          current.setAttribute(attribute.name, attribute.value);
      }
      patchControl(current, desired);
      if (current.tagName === "SELECT" && current.value !== desired.value)
        current.value = desired.value;
      if (current.tagName === "INPUT" && current.value !== desired.value)
        current.value = desired.value;
    }
    cursor = current.nextSibling;
  }
  while (cursor) {
    const next = cursor.nextSibling;
    cursor.remove();
    cursor = next;
  }
}
export function mountControl(host, client, page, changed = () => {}) {
  let data,
    disposed = false,
    working = false,
    search = "",
    sourceSearch = "",
    lastMarkup = "",
    restoreFocus = null,
    refreshing = null,
    pendingRoute = null,
    routeVersion = 0,
    arranging = false,
    editingId = null,
    draft = null,
    showPassword = false,
    focusedReceiver = receiverFocusCache.get(client) || "";
  const dialogs = new Set();
  const editDialog = (...args) => {
    const d = dialog(...args);
    dialogs.add(d);
    d.addEventListener("close", () => dialogs.delete(d));
    return d;
  };
  function refresh() {
    if (disposed) return Promise.resolve();
    if (refreshing) return refreshing;
    const version = routeVersion;
    const request = load(client, page)
      .then((next) => {
        if (!disposed && version === routeVersion) {
          const cache = routeCache.get(client);
          for (const id of cache.keys())
            if (!next.receivers.some((r) => r.config.id === id))
              cache.delete(id);
          for (const receiver of next.receivers) {
            if (receiver.state.online) {
              if (receiver.state.source)
                cache.set(receiver.config.id, receiver.state.source);
              else {
                cache.delete(receiver.config.id);
                receiver.state.last_source = null;
              }
            }
          }
          if (data && next.sourceErrors.length)
            for (const source of data.sources)
              if (!next.sources.some((s) => s.name === source.name))
                next.sources.push(source);
          data = next;
          if (!host.querySelector("[data-source-select]:focus")) render();
        }
      })
      .finally(() => {
        if (refreshing === request) refreshing = null;
      });
    refreshing = request;
    return request;
  }
  async function refreshAfterChange() {
    if (refreshing) await refreshing.catch(() => {});
    return refresh();
  }
  async function mutate(op, params, summary) {
    const safety =
      op.endsWith(".remove") ||
      op === "simple.delete" ||
      (op === "simple.update" && params.enabled === false) ||
      op.startsWith("event.");
    const perform = async () => {
      working = true;
      const task = beginTask(
        op.startsWith("simple.")
          ? "Simple Mode"
          : op.startsWith("sources.")
            ? "Sources"
            : "Device",
      );
      task.step(0, summary || t("Saving changes"));
      try {
        await client.call(op, {
          ...params,
          confirmed: true,
          expected_revision: data.info.revision,
        });
        lastMarkup = "";
        await refresh();
        await changed();
        task.done();
      } catch (error) {
        task.fail(t(error.message));
        if (error.code === "revision_conflict") await refresh();
        throw error;
      } finally {
        working = false;
      }
    };
    if (safety) return confirmChange("Confirm changes", summary, perform);
    await perform();
    return true;
  }

  async function route(receiver, source) {
    if (working || disposed) return;
    working = true;
    routeVersion += 1; // Discard reads started before this switch.
    pendingRoute = { receiver: receiver.config.id, source };
    const task = beginTask("Switching…");
    task.step(0, `${receiver.config.label} ← ${source}`);
    toast("Switching…", "loading", "routing");
    render();
    try {
      const confirmed = await client.call("route.set", {
        receiver: receiver.config.id,
        source,
      });
      if (disposed) {
        task.fail(t("Device disconnected. Reconnect to continue."));
        return;
      }
      const current = data.receivers.find(
        (r) => r.config.id === receiver.config.id,
      );
      if (current)
        current.state = {
          ...current.state,
          ...confirmed,
          last_source: confirmed.source,
        };
      routeCache.get(client)?.set(receiver.config.id, confirmed.source);
      pendingRoute = null;
      render();
      task.done(`${receiver.config.label} ← ${confirmed.source}`);
      toast("Routing verified", "success", "routing");
      void refreshAfterChange().catch(() =>
        toast(
          "Refresh failed. Displayed state may be out of date.",
          "error",
          "refresh-error",
        ),
      );
    } catch (error) {
      task.fail(t(error.message));
      if (!disposed) {
        toast(
          `${receiver.config.label}: ${t(error.message)}`,
          "error",
          "routing",
        );
        void refreshAfterChange().catch(() => {});
      }
    } finally {
      working = false;
      pendingRoute = null;
      render();
    }
  }
  function sourceEditor(source) {
    const d = editDialog(
      source ? "Rename source" : "Add source",
      `${
        source
          ? `<p class="secondary">${e(source.original_name)}</p>`
          : `<label class="field">${t("Source")}<select name="source" aria-label="${t("Source")}" required>${data.sources
              .filter((s) => !data.saved.some((x) => x.source === s.name))
              .map((s) => `<option value="${e(s.name)}">${e(s.name)}</option>`)
              .join("")}</select></label>`
      }${field("Display name", "display_name", source?.display_name || "", 'maxlength="64"')}`,
      async (f, d) => {
        const sourceId = source?.source || f.get("source");
        const name = f.get("display_name") || sourceId;
        if (
          await mutate(
            source ? "sources.saved.update" : "sources.saved.add",
            source
              ? { id: source.id, display_name: name }
              : { source: sourceId, display_name: name },
            `${t("Save source")}: ${sourceId} → ${name}`,
          )
        )
          d.close();
      },
    );
    if (source) {
      d.querySelector(".dialog-body").insertAdjacentHTML(
        "beforeend",
        b("Remove", "delete-source", 'class="quiet danger"'),
      );
      d.querySelector('[data-control="delete-source"]').onclick = async () => {
        try {
          if (
            await mutate(
              "sources.saved.remove",
              { id: source.id },
              "Remove saved source? The network source and existing routing will not be changed.",
            )
          )
            d.close();
        } catch (error) {
          toast(error.message, "error");
        }
      };
    }
  }
  function receiverEditor(receiver) {
    const config = receiver?.config;
    const d = editDialog(
      receiver ? "Edit receiver" : "Add device",
      `${field("Name", "label", config?.label || "", 'required maxlength="64"')}${field("IP address", "ip", config?.ip || "", 'required inputmode="decimal" placeholder="192.168.1.100"')}<details class="disclosure"><summary>${t("Advanced")}</summary><div class="form-grid">${field("API port", "port", config?.port || 8080, 'type="number" min="1" max="65535"')}${field("Channel", "channel", config?.channel || 1, 'type="number" min="1" max="4"')}</div></details>${receiver ? b("Remove receiver", "remove-output", 'class="quiet danger"') : b("Discover receivers", "discover-output")}`,
      async (f, d) => {
        working = true;
        const task = beginTask("Save device");
        task.step(0, String(f.get("label")));
        try {
          await client.call("receivers.add", {
            id: config?.id || randomId(),
            label: f.get("label"),
            ip: f.get("ip"),
            port: Number(f.get("port")),
            channel: Number(f.get("channel")),
          });
          await refresh();
          await changed();
          task.done();
          d.close();
        } catch (error) {
          task.fail(t(error.message));
          throw error;
        } finally {
          working = false;
        }
      },
    );
    d.querySelector('[data-control="remove-output"]')?.addEventListener(
      "click",
      async () => {
        try {
          if (
            await mutate(
              "receivers.remove",
              { id: config.id },
              "Remove receiver?",
            )
          )
            d.close();
        } catch (error) {
          toast(error.message, "error");
        }
      },
    );
    d.querySelector('[data-control="discover-output"]')?.addEventListener(
      "click",
      async (event) => {
        event.currentTarget.disabled = true;
        working = true;
        try {
          const found = await client.call("receivers.discover");
          for (const receiver of found)
            await client.call("receivers.add", receiver);
          await refresh();
          await changed();
          if (found.length) d.close();
          else toast("No receivers found. Add a receiver by IP.");
        } catch (error) {
          toast(error.message, "error");
        } finally {
          working = false;
          if (d.isConnected)
            d.querySelector('[data-control="discover-output"]').disabled =
              false;
        }
      },
    );
  }
  function blankSimpleAction() {
    return {
      id: randomId(),
      label: "",
      receiver: data.receivers[0]?.config.id || "",
      source: data.saved[0]?.source || data.sources[0]?.name || "",
      icon: null,
      enabled: true,
      order: 0,
    };
  }
  function startSimpleCreate() {
    editingId = "new";
    draft = {
      name: "",
      password: "",
      actions: [blankSimpleAction()],
    };
    showPassword = false;
    lastMarkup = "";
    render();
  }
  function startSimpleEdit(profile) {
    if (!profile) return;
    editingId = profile.id;
    draft = {
      name: profile.name || "",
      password: "",
      enabled: profile.enabled,
      actions: structuredClone(profile.actions?.length ? profile.actions : [blankSimpleAction()]),
    };
    showPassword = false;
    lastMarkup = "";
    render();
  }
  function cancelSimpleEdit() {
    editingId = null;
    draft = null;
    showPassword = false;
    lastMarkup = "";
    render();
  }
  function syncSimpleDraft() {
    const form = host.querySelector("[data-simple-form]");
    if (!form || !draft) return;
    const nameInput = form.querySelector("[name=profile-name]");
    const passInput = form.querySelector("[name=profile-password]");
    if (nameInput) draft.name = nameInput.value;
    if (passInput) draft.password = passInput.value;
    form.querySelectorAll("[data-button]").forEach((el, i) => {
      if (!draft.actions[i]) return;
      draft.actions[i] = {
        ...draft.actions[i],
        label: el.querySelector("[name=label]")?.value ?? draft.actions[i].label,
        receiver: el.querySelector("[name=receiver]")?.value ?? draft.actions[i].receiver,
        source: el.querySelector("[name=source]")?.value ?? draft.actions[i].source,
        enabled: true,
        icon: null,
        order: i,
      };
    });
  }
  function simpleSourceOptions(selected) {
    const all = [
      ...new Set([
        ...data.saved.map((s) => s.source),
        ...data.sources.map((s) => s.name),
        selected,
      ]),
    ].filter(Boolean);
    if (!all.length) return `<option value="">${t("No source")}</option>`;
    return all
      .map(
        (s) =>
          `<option value="${e(s)}" ${s === selected ? "selected" : ""}>${e(labelFor(data, s))}</option>`,
      )
      .join("");
  }
  async function saveSimpleEdit() {
    syncSimpleDraft();
    const isNew = editingId === "new";
    const profile = isNew ? null : data.profiles.find((p) => p.id === editingId);
    const name = (draft.name || "").trim();
    const password = draft.password || "";
    if (!name) throw Error(t("Invalid label"));
    if (draft.actions.length < 1 || draft.actions.length > 10)
      throw Error(t("Use 1–10 action buttons"));
    for (const a of draft.actions) {
      if (!a.label.trim() || !a.receiver || !a.source) throw Error(t("Missing field"));
    }
    if ((isNew && !password) || password) {
      if (Array.from(password).length < 4 || Array.from(password).length > 128)
        throw Error(t("Password must contain 4–128 Unicode characters"));
    }
    const actions = draft.actions.map((a, i) => ({
      ...a,
      label: a.label.trim(),
      order: i,
      enabled: true,
      icon: null,
    }));
    const params = {
      name,
      enabled: profile?.enabled ?? true,
      actions,
      ...(password ? { password } : {}),
      ...(profile ? { id: profile.id } : {}),
    };
    working = true;
    const task = beginTask("Simple Mode");
    task.step(0, name);
    try {
      await client.call(isNew ? "simple.create" : "simple.update", {
        ...params,
        confirmed: true,
        expected_revision: data.info.revision,
      });
      editingId = null;
      draft = null;
      showPassword = false;
      lastMarkup = "";
      await refresh();
      await changed();
      task.done();
    } catch (error) {
      task.fail(t(error.message));
      if (error.code === "revision_conflict") await refresh();
      throw error;
    } finally {
      working = false;
    }
  }
  function render() {
    if (disposed || !data) return;
    if (editingId && draft) syncSimpleDraft();
    const markup = controlMarkup(data, page, {
      search,
      sourceSearch,
      working,
      pendingRoute,
      arranging,
      focusedReceiver,
      editingId,
      draft,
      showPassword,
    });
    if (markup === lastMarkup) return;
    const active = document.activeElement;
    const focusKey = host.contains(active)
      ? active.getAttribute("data-focus")
      : active === document.body
        ? restoreFocus
        : null;
    restoreFocus = focusKey;
    const selection = active?.selectionStart;
    const tabs = host.querySelector(".receiver-tabs");
    const tabsLeft = tabs?.scrollLeft || 0;
    const scroll = host.querySelector(".matrix-scroll");
    const scrollLeft = scroll?.scrollLeft || 0,
      scrollTop = scroll?.scrollTop || 0;
    if (page === "Routing" && host.querySelector(".routing-console")) {
      const template = document.createElement("template");
      template.innerHTML = markup;
      patchControl(host, template.content);
    } else host.innerHTML = markup;
    lastMarkup = markup;
    const nextTabs = host.querySelector(".receiver-tabs");
    if (nextTabs) nextTabs.scrollLeft = tabsLeft;
    const nextScroll = host.querySelector(".matrix-scroll");
    if (nextScroll) {
      nextScroll.scrollLeft = scrollLeft;
      nextScroll.scrollTop = scrollTop;
    }
    if (focusKey) {
      const next = [...host.querySelectorAll("[data-focus]")].find(
        (x) => x.dataset.focus === focusKey,
      );
      if (next && !next.disabled) {
        if (document.activeElement !== next)
          next.focus({ preventScroll: true });
        restoreFocus = null;
      }
      if (next?.type === "search" && selection != null)
        next.setSelectionRange(selection, selection);
    }
    localize(host);
  }
  host.oninput = (event) => {
    if (event.target.matches("[data-output-search]"))
      search = event.target.value;
    else if (event.target.matches("[data-source-search]"))
      sourceSearch = event.target.value;
    else return;
    render();
  };
  host.onkeydown = (event) => {
    const x = event.target.closest("[data-row]");
    const move = {
      ArrowRight: [0, 1],
      ArrowLeft: [0, -1],
      ArrowUp: [-1, 0],
      ArrowDown: [1, 0],
    }[event.key];
    if (x && move) {
      event.preventDefault();
      const row = Number(x.dataset.row),
        col = Number(x.dataset.col);
      const candidates = [...host.querySelectorAll("[data-row]")].filter(
        (button) => !button.disabled && button.getClientRects().length,
      );
      const axis = move[0] ? "row" : "col";
      const direction = move[0] || move[1];
      const position = move[0] ? row : col;
      const next = candidates
        .filter(
          (button) =>
            (move[0]
              ? Number(button.dataset.col) === col
              : Number(button.dataset.row) === row) &&
            (Number(button.dataset[axis]) - position) * direction > 0,
        )
        .sort(
          (a, b) =>
            (Number(a.dataset[axis]) - Number(b.dataset[axis])) * direction,
        )[0];
      next?.focus();
    }
  };
  host.onfocusout = (event) => {
    if (event.target.matches("[data-source-select]"))
      queueMicrotask(() => {
        if (!working && !disposed) render();
      });
  };
  host.onchange = (event) => {
    const simpleField = event.target.closest("[data-simple-form] [name]");
    if (simpleField && draft) {
      syncSimpleDraft();
      // Keep draft across re-renders without losing focus.
      lastMarkup = "";
      const focusKey = simpleField.getAttribute("data-focus");
      render();
      if (focusKey) {
        const next = host.querySelector(`[data-focus="${focusKey}"]`);
        if (next && document.activeElement !== next) next.focus({ preventScroll: true });
      }
      return;
    }
    const select = event.target.closest("[data-source-select]");
    if (!select || !select.value || working) return;
    const receiver = data.receivers.find(
      (r) => r.config.id === select.dataset.id,
    );
    if (receiver) void route(receiver, select.value);
  };
  host.onclick = async (event) => {
    const x = event.target.closest("[data-control]");
    if (!x || working) return;
    const id = x.dataset.id,
      action = x.dataset.control;
    const source = data.saved.find((s) => s.id === id),
      profile = data.profiles.find((p) => p.id === id);
    try {
      if (action === "source-add") sourceEditor();
      if (action === "source-discovered") {
        sourceEditor();
        const d = [...dialogs].at(-1);
        d.querySelector("[name=source]").value = x.dataset.source;
      }
      if (action === "source-edit") {
        const d = sourceEditor(source);
      }
      if (action === "receiver-add") receiverEditor();
      if (action === "ndi-reset") {
        routeVersion += 1;
        working = true;
        render();
        try {
          await resetNdiLists(client);
          await refreshAfterChange();
        } finally {
          working = false;
          render();
        }
      }
      if (action === "receiver-edit")
        receiverEditor(data.receivers.find((r) => r.config.id === id));
      if (action === "receiver-focus") {
        focusedReceiver = id;
        receiverFocusCache.set(client, id);
        render();
      }
      if (action === "arrange") {
        arranging = !arranging;
        render();
      }
      if (["receiver-up", "receiver-down"].includes(action)) {
        const ids = data.receivers.map((r) => r.config.id),
          i = ids.indexOf(id),
          j = i + (action === "receiver-up" ? -1 : 1);
        if (j >= 0 && j < ids.length) {
          [ids[i], ids[j]] = [ids[j], ids[i]];
          working = true;
          try {
            await client.call("receivers.reorder", { ids });
            await refresh();
            await changed();
          } finally {
            working = false;
          }
        }
      }
      if (action === "autofix") {
        routeVersion += 1;
        working = true;
        render();
        try {
          await autoFix(client);
          await refreshAfterChange();
        } finally {
          working = false;
          render();
        }
      }
      if (action === "source-cancel") {
        lastMarkup = "";
        render();
      }
      if (action === "source-remove")
        await mutate(
          "sources.saved.remove",
          { id },
          `${t("Remove saved source? The network source and existing routing will not be changed.")}\n${source.display_name}`,
        );
      if (["source-up", "source-down"].includes(action)) {
        const ids = data.saved.map((s) => s.id),
          i = ids.indexOf(id),
          j = action === "source-up" ? i - 1 : i + 1;
        [ids[i], ids[j]] = [ids[j], ids[i]];
        await mutate(
          "sources.saved.reorder",
          { ids },
          `${t("Reorder saved sources")}\n${ids.map((id) => data.saved.find((s) => s.id === id).display_name).join("\n")}`,
        );
      }
      if (action === "refresh") {
        working = true;
        x.disabled = true;
        await client.call("sources.refresh");
        await refresh();
        working = false;
        render();
      }
      if (action === "profile-add") {
        if (editingId) syncSimpleDraft();
        startSimpleCreate();
        return;
      }
      if (action === "profile-edit") {
        if (editingId && editingId !== id) syncSimpleDraft();
        startSimpleEdit(profile);
        return;
      }
      if (action === "simple-cancel") {
        cancelSimpleEdit();
        return;
      }
      if (action === "simple-show") {
        showPassword = !showPassword;
        syncSimpleDraft();
        lastMarkup = "";
        render();
        return;
      }
      if (action === "simple-add") {
        syncSimpleDraft();
        if (draft.actions.length < 10) draft.actions.push(blankSimpleAction());
        lastMarkup = "";
        render();
        return;
      }
      if (action === "simple-remove") {
        syncSimpleDraft();
        const i = Number(x.dataset.index);
        if (draft.actions.length > 1) draft.actions.splice(i, 1);
        lastMarkup = "";
        render();
        return;
      }
      if (action === "simple-up" || action === "simple-down") {
        syncSimpleDraft();
        const i = Number(x.dataset.index);
        const j = action === "simple-up" ? i - 1 : i + 1;
        if (draft.actions[j]) {
          [draft.actions[i], draft.actions[j]] = [draft.actions[j], draft.actions[i]];
          lastMarkup = "";
          render();
        }
        return;
      }
      if (action === "simple-save") {
        try {
          await saveSimpleEdit();
        } catch (error) {
          toast(error.message, "error");
        }
        lastMarkup = "";
        render();
        return;
      }
      if (action === "profile-delete") {
        const ok = await confirmChange(
          `${t("Delete")} “${profile?.name || ""}”?`,
          "Its buttons are deleted too.",
          async () => {},
        );
        if (!ok) return;
        await mutate("simple.delete", { id }, `${t("Delete")} “${profile?.name || ""}”`);
        if (editingId === id) {
          editingId = null;
          draft = null;
        }
        lastMarkup = "";
        render();
        return;
      }
      if (action === "profile-toggle") {
        if (!profile) return;
        working = true;
        const task = beginTask("Simple Mode");
        try {
          await client.call("simple.update", {
            id,
            enabled: !profile.enabled,
            confirmed: true,
            expected_revision: data.info.revision,
          });
          lastMarkup = "";
          await refresh();
          await changed();
          task.done();
        } catch (error) {
          task.fail(t(error.message));
          throw error;
        } finally {
          working = false;
        }
        render();
        return;
      }
      if (["profile-up", "profile-down"].includes(action)) {
        const i = data.profiles.indexOf(profile),
          j = action === "profile-up" ? i - 1 : i + 1;
        if (data.profiles[j]) {
          working = true;
          try {
            await client.call("simple.update", {
              id,
              order: j,
              confirmed: true,
              expected_revision: data.info.revision,
            });
            lastMarkup = "";
            await refresh();
            await changed();
          } finally {
            working = false;
          }
          render();
        }
        return;
      }
      if (action === "event")
        await mutate(
          data.event.enabled ? "event.disable" : "event.enable",
          {},
          data.event.enabled
            ? "Disable Event Mode? Simple Modes will become available again."
            : "Enabling Event Mode will temporarily disable all Simple Modes. Only the administrator will be able to control DRouter.",
        );
      if (action === "route")
        await route(
          data.receivers.find((r) => r.config.id === id),
          x.dataset.source,
        );
    } catch (error) {
      working = false;
      toast(error.message, "error", "control-error");
      render();
    }
  };
  host.innerHTML = `<p class="loading-state" role="status"><span class="spinner" aria-hidden="true"></span>${t("Loading device state…")}</p>`;
  const initialTask = page === "Access Control" ? beginTask("Settings") : null;
  initialTask?.step(0, t("Reading configuration"));
  void refresh()
    .then(() => initialTask?.done(t("Configuration loaded")))
    .catch((error) => {
      initialTask?.fail(t(error.message));
      if (!disposed) {
        host.textContent = "";
        toast(error.message, "error", "control-error");
      }
    });
  // Header Event Mode changes update the revision used by an immediately opened editor.
  const receiveInfo = ({ detail: info }) => {
    if (
      data &&
      info.revision >= data.info.revision &&
      info.event_mode !== data.info.event_mode
    ) {
      data.info = {
        ...data.info,
        revision: info.revision,
        event_mode: info.event_mode,
      };
      data.event.enabled = info.event_mode;
    }
  };
  const receiveRefresh = (event) => {
    if (event.detail?.client === client && !working)
      void refresh().catch(() => {});
  };
  document.addEventListener("drouter-controls-refresh", receiveRefresh);
  document.addEventListener("drouter-info", receiveInfo);
  document.addEventListener("drouter-language", render);
  const timer = setInterval(() => {
    if (
      !working &&
      !host.querySelector("[data-source-select]:focus") &&
      !dialogs.size &&
      host.getClientRects().length > 0 &&
      (!document.querySelector("dialog[open]") ||
        host.closest("dialog[open]") ===
          [...document.querySelectorAll("dialog[open]")].at(-1)) &&
      !host.querySelector(".inline-editor") &&
      document.visibilityState === "visible"
    )
      void refresh().catch(() => {
        toast(
          "Refresh failed. Displayed state may be out of date.",
          "error",
          "refresh-error",
        );
        render();
      });
  }, 10000);
  return () => {
    disposed = true;
    document.removeEventListener("drouter-language", render);
    document.removeEventListener("drouter-info", receiveInfo);
    document.removeEventListener("drouter-controls-refresh", receiveRefresh);
    clearInterval(timer);
    dialogs.forEach((d) => d.close());
    host.onclick = null;
    host.oninput = null;
    host.onchange = null;
    host.onkeydown = null;
    host.onfocusout = null;
    host.onkeydown = null;
    host.oninput = null;
    host.onchange = null;
  };
}
export function mountSimple(host, client, logout) {
  let stopped = false,
    pending = null,
    profile,
    reading = null,
    lastMarkup = "";
  function leave(message) {
    if (stopped) return;
    stopped = true;
    client.onDisconnect = () => {};
    logout(message);
  }
  function render() {
    if (stopped || !profile) return;
    const markup = `<main class="simple-screen"><header><strong>DRouter</strong>${languageControl()}${b("Logout", "logout")}</header><div class="simple-heading"><h1 data-user-content>${e(profile.name)}</h1><p data-user-content>${e(profile.description)}</p></div>${profile.locked ? `<div class="notice" role="status"><h2>${t("Event Mode")}</h2><p>${t("Simple Mode is temporarily locked by the administrator.")}</p></div>` : `<div class="simple-grid">${profile.actions.map((a) => b(`${e(a.label)}${pending === a.id ? " · " + t("Switching…") : ""}`, a.id, `data-user-content class="simple-action ${pending === a.id ? "pending" : ""}" ${pending ? "disabled" : ""}`)).join("")}</div><div class="simple-tools">${b(pending === "autofix" ? "Auto bugfix running…" : "Auto bugfix", "autofix", pending ? "disabled" : "")}</div>`}</main>`;
    if (markup !== lastMarkup) {
      host.innerHTML = markup;
      lastMarkup = markup;
    }
  }
  async function refresh() {
    if (reading) return reading;
    reading = client.call("simple.actions.list").then((next) => {
      profile = next;
      render();
    });
    try {
      await reading;
    } finally {
      reading = null;
    }
  }
  host.onclick = async (event) => {
    const x = event.target.closest("[data-control]");
    if (!x) return;
    if (x.dataset.control === "logout") {
      try {
        await client.call("auth.logout");
      } finally {
        leave();
      }
      return;
    }
    if (pending || profile?.locked) return;
    if (x.dataset.control === "autofix") {
      pending = "autofix";
      render();
      try {
        await autoFix(client, profile.actions);
      } catch (error) {
        toast(error.message, "error", "autofix");
      } finally {
        pending = null;
        render();
      }
      return;
    }
    pending = x.dataset.control;
    toast("Switching…", "loading", "simple-routing");
    render();
    try {
      await client.call("simple.action.execute", { id: pending });
      toast("Routing verified", "success", "simple-routing");
    } catch (error) {
      toast(error.message, "error", "simple-routing");
    } finally {
      await refresh().catch(() => leave());
      pending = null;
      render();
    }
  };
  client.onDisconnect = () =>
    leave("Device disconnected. Reconnect to continue.");
  void refresh().catch(() => leave());
  document.addEventListener("drouter-language", render);
  const timer = setInterval(() => {
    if (!pending && !reading && document.visibilityState === "visible")
      void refresh().catch(() => leave());
  }, 2500);
  return () => {
    stopped = true;
    client.onDisconnect = () => {};
    document.removeEventListener("drouter-language", render);
    clearInterval(timer);
    host.onclick = null;
    host.oninput = null;
    host.onchange = null;
    host.onkeydown = null;
    host.onfocusout = null;
  };
}

function controlMarkup(data, page, state) {
  const {
    search,
    sourceSearch,
    working,
    pendingRoute,
    arranging,
    focusedReceiver,
    editingId,
    draft,
    showPassword,
  } = state;
  const simpleSources = (selected) => {
    const all = [
      ...new Set([
        ...data.saved.map((s) => s.source),
        ...data.sources.map((s) => s.name),
        selected,
      ]),
    ].filter(Boolean);
    if (!all.length) return `<option value="">${t("No source")}</option>`;
    return all
      .map(
        (s) =>
          `<option value="${e(s)}" ${s === selected ? "selected" : ""}>${e(labelFor(data, s))}</option>`,
      )
      .join("");
  };
  const simpleForm = (isNew) => {
    if (!draft) return "";
    const isEdit = !isNew;
    return `<div class="simple-edit" data-simple-form="${isNew ? "new" : e(editingId)}">
      <div class="simple-edit-grid">
        <label class="field"><span>${t("Name")}</span><input name="profile-name" value="${e(draft.name || "")}" maxlength="64" required autocomplete="off" data-focus="simple-name" placeholder="${t("Name")}"></label>
        <label class="field"><span>${t("Password")}</span><span class="password-control"><input name="profile-password" type="${showPassword ? "text" : "password"}" autocomplete="new-password" ${isNew ? "required" : `placeholder="${e(t("Leave empty to keep the current password."))}"`} value="${e(draft.password || "")}" data-focus="simple-password" aria-label="${t("Password")}">${b(showPassword ? "Hide password" : "Show password", "simple-show", 'class="quiet"')}</span></label>
      </div>
      <div class="action-heading"><h3>${t("Button")}</h3><small>${draft.actions.length} / 10</small></div>
      <div class="simple-action-list">${draft.actions
        .map(
          (a, i) => `<div class="action-mapping" data-button="${i}">
          <span class="action-number">${i + 1}</span>
          <input name="label" value="${e(a.label || "")}" maxlength="64" required placeholder="${t("Label")}" aria-label="${t("Label")}" data-focus="simple-label-${i}" autocomplete="off">
          <select name="receiver" aria-label="${t("Output")}" data-focus="simple-recv-${i}" required>${data.receivers.map((r) => `<option value="${e(r.config.id)}" ${r.config.id === a.receiver ? "selected" : ""}>${e(r.config.label)}</option>`).join("")}</select>
          <select name="source" aria-label="${t("Source")}" data-focus="simple-src-${i}" required>${simpleSources(a.source)}</select>
          <div class="mapping-row-actions">${b("↑", "simple-up", `aria-label="${t("Move button up")}" data-index="${i}" ${i === 0 ? "disabled" : ""}`)}${b("↓", "simple-down", `aria-label="${t("Move button down")}" data-index="${i}" ${i === draft.actions.length - 1 ? "disabled" : ""}`)}${b("×", "simple-remove", `aria-label="${t("Remove button")}" data-index="${i}" ${draft.actions.length === 1 ? "disabled" : ""}`)}</div>
        </div>`,
        )
        .join("")}</div>
      <div class="form-actions simple-edit-actions">${b("+", "simple-add", `aria-label="${t("Add button")}" ${draft.actions.length >= 10 ? "disabled" : ""}`)}<span class="spacer"></span>${b("Cancel", "simple-cancel", 'class="quiet"')}<button type="button" data-control="simple-save" class="primary" ${working ? "disabled" : ""}>${t("Save")}</button></div>
    </div>`;
  };
  const simpleRow = (p) => {
    const isEditing = editingId === p.id && draft;
    return `<div class="simple-item" data-profile="${e(p.id)}">
      <div class="list-row simple-row">
        <div class="list-main"><strong data-user-content>${e(p.name)}</strong><small>${p.actions.length} / 10</small></div>
        <div class="row-actions">
          <button type="button" data-control="profile-toggle" data-id="${e(p.id)}" class="event-toggle" role="switch" aria-label="${e(t("Enable") + " " + p.name)}" aria-checked="${p.enabled}"><span class="switch-track" aria-hidden="true"></span></button>
          ${b("Edit", "profile-edit", `data-id="${e(p.id)}"`)}
          ${b("Delete", "profile-delete", `class="quiet danger" data-id="${e(p.id)}"`)}
        </div>
      </div>
      ${isEditing ? simpleForm(false) : ""}
    </div>`;
  };
  const pending = (r, source) =>
    pendingRoute?.receiver === r.config.id && pendingRoute?.source === source;
  const searchInput = (label, key, value) =>
    `<label class="search-field ${key === "source" ? "source-filter" : ""}"><span class="sr-only">${t(label)}</span><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><circle cx="10" cy="10" r="6"/><path d="m15 15 5 5"/></svg><input type="search" aria-label="${t(label)}" placeholder="${t(label)}" data-${key}-search data-focus="${key}-search" value="${e(value)}" autocomplete="off"></label>`;
  const order = (kind, item, i, length) =>
    `<div class="order-actions">${b(kind === "receiver" ? "←" : "↑", `${kind}-up`, `data-focus="${kind}-up-${e(item.id)}" aria-label="${t(kind === "receiver" ? "Move left" : "Move up")} · ${e(item.display_name || item.name)}" data-id="${e(item.id)}" ${i === 0 ? "disabled" : ""}`)}${b(kind === "receiver" ? "→" : "↓", `${kind}-down`, `data-focus="${kind}-down-${e(item.id)}" aria-label="${t(kind === "receiver" ? "Move right" : "Move down")} · ${e(item.display_name || item.name)}" data-id="${e(item.id)}" ${i === length - 1 ? "disabled" : ""}`)}</div>`;
  if (page === "Sources") {
    const matches = (s) =>
      `${s.display_name || ""} ${s.source || s.name}`
        .toLowerCase()
        .includes(sourceSearch.toLowerCase());
    return `<div class="routing-tools">${searchInput("Search sources", "source", sourceSearch)}${b("Save source", "source-add", 'class="primary"')}${b("Refresh sources", "refresh", working ? "disabled" : "")}</div><h2 class="list-section-title">${t("Saved sources")}</h2><div class="data-list source-list-management">${
      data.saved
        .filter(matches)
        .map((s) => {
          const available = data.sources.some((x) => x.name === s.source);
          return `<div class="list-row"><div class="list-main"><strong data-user-content>${e(s.display_name)}</strong><small data-user-content>${e(s.original_name)}</small></div><span class="status-text"><span class="status-dot ${available ? "" : "offline"}"></span>${t(available ? "Available" : "Unavailable")}</span><div class="row-actions">${b("Rename", "source-edit", `data-id="${e(s.id)}"`)}${order("source", s, data.saved.indexOf(s), data.saved.length)}${b("Remove", "source-remove", `class="quiet danger" data-id="${e(s.id)}"`)}</div></div>`;
        })
        .join("") || empty("No saved sources")
    }</div><h2 class="list-section-title">${t("Discovered sources")}</h2><div class="data-list">${
      data.sources
        .filter(matches)
        .map(
          (s) =>
            `<div class="list-row"><span class="list-main" data-user-content>${e(s.name)}</span>${data.saved.some((x) => x.source === s.name) ? `<span class="secondary">${t("Saved")}</span>` : b("Save source", "source-discovered", `data-source="${e(s.name)}"`)}</div>`,
        )
        .join("") || empty("No matching sources")
    }</div>`;
  }
  if (page === "Simple Modes")
    return `<div class="form-actions">${b("Create Simple Mode", "profile-add", 'class="primary"')}</div>${editingId === "new" && draft ? simpleForm(true) : ""}<div class="data-list profile-list">${data.profiles.map((p) => simpleRow(p)).join("") || empty("No Simple Modes configured")}</div>`;
  if (page === "Access Control")
    return `<div class="access-heading"><h2>${t("Simple Mode")}</h2>${editingId ? "" : b("+", "profile-add", `class="primary" aria-label="${t("Create Simple Mode")}"` )}</div>${editingId === "new" && draft ? simpleForm(true) : ""}<div class="data-list profile-list">${data.profiles.map((p) => simpleRow(p)).join("") || (editingId === "new" ? "" : empty("No Simple Modes configured"))}</div>`;
  if (page !== "Routing") return "";
  const receivers = data.receivers.filter((r) =>
    `${r.config.label} ${r.config.ip}`
      .toLowerCase()
      .includes(search.toLowerCase()),
  );
  const saved = data.saved.filter((s) =>
    `${s.display_name} ${s.source}`
      .toLowerCase()
      .includes(sourceSearch.toLowerCase()),
  );
  const mobileReceiver =
    receivers.find((r) => r.config.id === focusedReceiver) || receivers[0];
  const check =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" aria-hidden="true"><path d="m5 12 4 4L19 6"/></svg>';
  const mobile = (r) => `data-mobile-visible="${r === mobileReceiver}"`;
  const routeButton = (r, source, row, col) => {
    const active = r.state.source === source.source;
    const waiting = pending(r, source.source);
    return b(
      `<span class="crosspoint-mark" aria-hidden="true">${waiting ? '<span class="spinner"></span>' : active ? check : '<span class="crosspoint-ring"></span>'}</span><span class="crosspoint-copy">${t(waiting ? "Switching…" : active ? "Active" : r.state.online ? "Switch" : "Retry switch")}</span>`,
      "route",
      `class="crosspoint ${active ? "active" : ""} ${waiting ? "pending" : ""}" data-focus="matrix-${e(r.config.id)}-${e(source.id)}" data-row="${row}" data-col="${col}" data-id="${e(r.config.id)}" data-source="${e(source.source)}" aria-label="${e(t("Route {source} to {output}", { source: source.display_name, output: r.config.label }))}" aria-pressed="${active}" ${working ? "disabled" : ""}`,
    );
  };
  const sourceSelect = (r) => {
    const current = currentSource(r);
    const switching = pendingRoute?.receiver === r.config.id;
    const known = data.sources.some((source) => source.name === current);
    return `<select class="matrix-picker" data-source-select data-id="${e(r.config.id)}" data-focus="ndi-source-${e(r.config.id)}" aria-label="${e(t("NDI source for {output}", { output: r.config.label }))}" ${working || !data.sources.length ? "disabled" : ""}><option value="" disabled ${switching || !current ? "selected" : ""}>${t(switching ? "Switching…" : "Choose NDI source")}</option>${current && !known && !switching ? `<option data-user-content value="${e(current)}" selected disabled>${e(labelFor(data, current))} · ${t("Unavailable")}</option>` : ""}${data.sources
      .map((source) => {
        const alias = labelFor(data, source.name);
        return `<option data-user-content value="${e(source.name)}" ${!switching && source.name === current ? "selected" : ""}>${e(alias === source.name ? source.name : `${alias} · ${source.name}`)}</option>`;
      })
      .join("")}</select>`;
  };
  const edit = (label, action, id) =>
    b(
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><path d="m15 4 5 5M4 20l4-1L20 7a2.8 2.8 0 0 0-4-4L4 15z"/></svg>',
      action,
      `class="quiet icon-button header-edit" data-id="${e(id)}" aria-label="${e(t(label))}"`,
    );
  const sourceOrder = (source) =>
    arranging
      ? order("source", source, data.saved.indexOf(source), data.saved.length)
      : "";
  const receiverOrder = (r) =>
    arranging
      ? order(
          "receiver",
          { id: r.config.id, name: r.config.label },
          data.receivers.indexOf(r),
          data.receivers.length,
        )
      : "";
  const receiverTabs = `<div class="receiver-tabs" role="group" aria-label="${t("Choose receiver")}">${receivers.map((r) => b(`<span class="receiver-tab-name"><span class="status-dot ${r.state.online ? "" : "offline"}"></span><strong data-user-content>${e(r.config.label)}</strong></span><span class="receiver-tab-source" data-user-content>${e(labelFor(data, currentSource(r)))}</span>`, "receiver-focus", `class="receiver-tab" data-id="${e(r.config.id)}" data-focus="receiver-focus-${e(r.config.id)}" aria-pressed="${r === mobileReceiver}" aria-label="${e(t("Show receiver {output}", { output: r.config.label }))}"`)).join("")}</div>`;
  const emptyState = !receivers.length
    ? `<div class="matrix-empty"><h2>${t(data.receivers.length ? "No matching outputs" : "No outputs connected")}</h2><p>${t(data.receivers.length ? "Try another search." : "Add a receiver and a source to start routing.")}</p></div>`
    : !saved.length
      ? `<tr class="matrix-empty-row" data-key="empty-sources"><td colspan="${receivers.length + 1}"><p>${t(data.saved.length ? "No matching sources" : "No saved sources")}</p>${data.saved.length ? "" : b("+ Add source", "source-add", 'class="quiet"')}</td></tr>`
      : "";
  return `<div class="routing-console"><div class="routing-tools">${searchInput("Find a source", "source", sourceSearch)}${searchInput("Find an output", "output", search)}<div class="routing-tool-actions">${b(arranging ? "Done" : "Reorder", "arrange", `class="${arranging ? "primary" : ""}" aria-pressed="${arranging}"`)}${b("Auto bugfix", "autofix", working ? "disabled" : "")}</div></div>${receiverTabs}<div class="matrix-frame"><div class="matrix-scroll" role="region" aria-label="${t("Routing matrix")}" tabindex="0"><table class="route-table"><caption class="sr-only">${t("Transmitters are rows. Receivers are columns. Select a cell to switch.")}</caption><thead><tr><th scope="col" class="matrix-corner"><span>${t("Receiver")} <span aria-hidden="true">→</span></span><strong>${t("Transmitter")} <span aria-hidden="true">↓</span></strong></th>${receivers.map((r, col) => `<th scope="col" data-key="receiver-${e(r.config.id)}" class="receiver-column ${r.state.online ? "" : "receiver-offline"}" data-route-col="${col}" ${mobile(r)}><div class="receiver-header"><strong class="receiver-name" data-user-content>${e(r.config.label)}</strong>${edit("Edit receiver", "receiver-edit", r.config.id)}</div><span class="receiver-state"><span class="status-dot ${r.state.online ? "" : "offline"}"></span>${t(r.state.online ? "Online" : "Offline")}</span><div class="output-source"><small>${t(r.state.online ? "Current source" : "Last known")}</small><span data-user-content>${e(currentSource(r) ? labelFor(data, currentSource(r)) : t("No source"))}</span></div>${receiverOrder(r)}</th>`).join("")}</tr></thead><tbody>${saved.map((source, row) => `<tr class="source-row" data-key="source-${e(source.id)}"><th scope="row"><div class="source-header"><span class="matrix-index" aria-hidden="true">${String(data.saved.indexOf(source) + 1).padStart(2, "0")}</span><div class="source-identity"><strong data-user-content>${e(source.display_name)}</strong>${source.display_name !== source.source ? `<small title="${e(source.source)}" data-user-content>${e(source.source)}</small>` : ""}${data.sources.some((s) => s.name === source.source) ? "" : `<small class="unavailable-source">${t("Unavailable")}</small>`}</div>${edit("Edit source", "source-edit", source.id)}</div>${sourceOrder(source)}</th>${receivers.map((r, col) => `<td data-key="route-${e(r.config.id)}" class="route-cell ${r.state.source === source.source ? "route-active" : ""} ${r.state.online ? "" : "receiver-offline"}" data-route-col="${col}" ${mobile(r)}>${routeButton(r, source, row, col)}</td>`).join("")}</tr>`).join("")}${receivers.length ? emptyState : ""}<tr class="other-source" data-key="other-sources"><th scope="row"><strong>${t("Other device")}</strong><small>${t("All NDI sources")}</small>${b("NDI list reset", "ndi-reset", `class="quiet ndi-reset-button" ${working ? "disabled" : ""}`)}</th>${receivers.map((r, col) => `<td data-key="other-${e(r.config.id)}" data-route-col="${col}" ${mobile(r)} class="${currentSource(r) && !data.saved.some((source) => source.source === currentSource(r)) ? "other-active" : ""}">${sourceSelect(r)}</td>`).join("")}</tr></tbody></table>${receivers.length ? "" : emptyState}</div><div class="matrix-bottom"><div class="matrix-add-actions">${b("+ Add source", "source-add")}${b("+ Add device", "receiver-add")}</div><span class="matrix-hint"><span class="legend-active" aria-hidden="true">${check}</span>${t("Verified active source")}</span></div></div></div>`;
}
