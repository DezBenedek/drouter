import { randomId } from "./client.js";
import { t, languageControl, localize } from "./i18n.js";
// Shared Sonner-style notifications: no React or extra runtime on the ESP32.
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
  d.innerHTML = `<form><header class="dialog-header"><h2>${t(title)}</h2>${b("Close", "close", 'class="quiet"')}</header><div class="dialog-body">${body}</div><footer class="dialog-footer">${b("Cancel", "close")}<button class="primary">${t(action)}</button></footer></form>`;
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
const routeCache = new WeakMap();
const currentSource = (r) => r.state.source || r.state.last_source;
async function load(client, page) {
  const ops =
    page === "Access Control"
      ? ["device.info"]
      : [
          "device.info",
          "sources.saved.list",
          "sources.list",
          "receivers.list",
          ...(page === "Simple Modes" ? ["simple.list"] : []),
        ];
  const [
    info,
    saved = [],
    discovered = { sources: [] },
    receivers = [],
    profiles = [],
  ] = await Promise.all(ops.map((op) => client.call(op)));
  publishInfo(info);
  let cache = routeCache.get(client);
  if (!cache) {
    cache = new Map();
    routeCache.set(client, cache);
  }
  for (const id of page === "Access Control" ? [] : cache.keys())
    if (!receivers.some((r) => r.config.id === id)) cache.delete(id);
  for (const receiver of receivers) {
    if (receiver.state.source)
      cache.set(receiver.config.id, receiver.state.source);
    receiver.state.last_source = cache.get(receiver.config.id) || null;
  }
  return {
    info,
    saved,
    sources: discovered.sources,
    receivers,
    profiles,
    event: { enabled: info.event_mode },
  };
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
    pendingRoute = null;
  const dialogs = new Set();
  const editDialog = (...args) => {
    const d = dialog(...args);
    dialogs.add(d);
    d.addEventListener("close", () => dialogs.delete(d));
    return d;
  };
  async function refresh() {
    if (disposed) return;
    if (refreshing) await refreshing;
    if (disposed) return;
    const request = load(client, page);
    refreshing = request;
    try {
      const next = await request;
      if (!disposed) {
        data = next;
        render();
      }
    } finally {
      if (refreshing === request) refreshing = null;
    }
  }
  async function mutate(op, params, summary) {
    const safety =
      op.endsWith(".remove") ||
      op === "simple.delete" ||
      (op === "simple.update" && params.enabled === false) ||
      op.startsWith("event.");
    const perform = async () => {
      working = true;
      try {
        await client.call(op, {
          ...params,
          confirmed: true,
          expected_revision: data.info.revision,
        });
        lastMarkup = "";
        await refresh();
        await changed();
      } finally {
        working = false;
      }
    };
    if (safety) return confirmChange("Confirm changes", summary, perform);
    await perform();
    return true;
  }

  async function route(receiver, source) {
    if (working) return;
    working = true;
    pendingRoute = { receiver: receiver.config.id, source };
    toast("Switching…", "loading", "routing");
    render();
    try {
      await client.call("route.set", { receiver: receiver.config.id, source });
      toast("Routing verified", "success", "routing");
      await refresh();
    } catch (error) {
      toast(
        `${receiver.config.label}: ${t(error.message)}`,
        "error",
        "routing",
      );
    } finally {
      working = false;
      pendingRoute = null;
      render();
    }
  }
  function sourceEditor(source) {
    editDialog(
      source ? "Rename source" : "Save source",
      `${
        source
          ? `<p class="secondary">${e(source.original_name)}</p>`
          : `<label class="field">${t("Source")}<select name="source" required>${data.sources
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
  }
  function profileEditor(profile) {
    let actions = structuredClone(
      profile?.actions || [
        {
          id: randomId(),
          label: "",
          receiver: data.receivers[0]?.config.id || "",
          source: data.sources[0]?.name || "",
          icon: null,
          enabled: true,
          order: 0,
        },
      ],
    );
    let openAction = actions[0].id;
    const d = editDialog(
      profile ? "Edit Simple Mode" : "Create Simple Mode",
      `<div class="profile-basics">${field("Profile name", "name", profile?.name || "", 'required maxlength="64"')}<label class="field">${t("Password")}<span class="password-control"><input name="password" aria-label="${t("Password")}" type="password" autocomplete="new-password" ${profile ? `placeholder="${t("Leave empty to keep the current password.")}"` : "required"}>${b("Show password", "visible")}</span></label></div>${field("Description", "description", profile?.description || "", 'maxlength="256"')}<p class="help-text">${t("Use 4–128 Unicode characters. Short passwords are weak; use a longer password when possible.")}</p><label class="field-row"><input type="checkbox" name="enabled" ${profile?.enabled === false ? "" : "checked"}>${t("Enabled")}</label><div class="action-heading"><h3>${t("Action buttons")}</h3><small data-count></small></div><div data-actions></div>${b("Add button", "add")}`,
      async (f, d) => {
        readActions();
        if (actions.length < 1 || actions.length > 10)
          throw Error("Use 1–10 action buttons");
        const password = f.get("password");
        if (
          password &&
          (Array.from(password).length < 4 || Array.from(password).length > 128)
        )
          throw Error("Password must contain 4–128 Unicode characters");
        const params = {
          name: f.get("name"),
          description: f.get("description"),
          enabled: f.has("enabled"),
          actions,
          ...(password ? { password } : {}),
          ...(profile ? { id: profile.id } : {}),
        };
        const mappings = actions
          .map(
            (a) =>
              `${a.label}: ${data.receivers.find((r) => r.config.id === a.receiver)?.config.label || a.receiver} ← ${labelFor(data, a.source)} (${a.source})`,
          )
          .join("\n");
        if (
          await mutate(
            profile ? "simple.update" : "simple.create",
            params,
            `${params.name}\n${t(params.enabled ? "Enabled" : "Disabled")}\n${password ? t("Password will be changed") : ""}\n${mappings}`,
          )
        )
          d.close();
      },
    );
    d.classList.add("profile-editor");
    d.addEventListener(
      "invalid",
      (event) => {
        const mapping = event.target.closest("[data-button]");
        if (mapping) mapping.open = true;
      },
      true,
    );
    function readActions() {
      d.querySelectorAll("[data-button]").forEach((el, i) => {
        actions[i] = {
          ...actions[i],
          label: el.querySelector("[name=label]").value,
          icon: el.querySelector("[name=icon]").value || null,
          receiver: el.querySelector("[name=receiver]").value,
          source: el.querySelector("[name=source]").value,
          enabled: el.querySelector("[name=action-enabled]").checked,
          order: i,
        };
      });
    }
    function draw() {
      d.querySelector("[data-actions]").innerHTML = actions
        .map(
          (a, i) =>
            `<details class="action-mapping" data-button="${i}" ${a.id === openAction ? "open" : ""}><summary><span class="action-number">${i + 1}</span><span><strong data-button-label data-user-content>${e(a.label || t("New button"))}</strong><small data-button-mapping data-user-content>${e(data.receivers.find((r) => r.config.id === a.receiver)?.config.label || t("Output"))} ← ${e(labelFor(data, a.source))}</small></span></summary><div class="mapping-body"><div class="mapping-fields"><div class="mapping-label">${field("Label", "label", a.label, 'required maxlength="64"')}</div><label class="field">${t("Output")}<select name="receiver" required>${data.receivers.map((r) => `<option value="${e(r.config.id)}" ${r.config.id === a.receiver ? "selected" : ""}>${e(r.config.label)}</option>`).join("")}</select></label><label class="field">${t("Source")}<select name="source" required>${[
              ...new Set([...data.sources.map((s) => s.name), a.source]),
            ]
              .filter(Boolean)
              .map(
                (s) =>
                  `<option value="${e(s)}" ${s === a.source ? "selected" : ""}>${e(labelFor(data, s))}</option>`,
              )
              .join(
                "",
              )}</select></label></div><div class="mapping-options"><details><summary>${t("More options")}</summary>${field("Icon (optional)", "icon", a.icon || "", 'maxlength="32"')}</details><label class="field-row"><input type="checkbox" name="action-enabled" ${a.enabled ? "checked" : ""}>${t("Enabled")}</label><div class="inline-actions">${b("↑", "up", `aria-label="${t("Move button up")}" data-index="${i}" ${i === 0 ? "disabled" : ""}`)}${b("↓", "down", `aria-label="${t("Move button down")}" data-index="${i}" ${i === actions.length - 1 ? "disabled" : ""}`)}${b("Remove button", "remove", `data-index="${i}" ${actions.length === 1 ? "disabled" : ""}`)}</div></div></div></details>`,
        )
        .join("");
      d.querySelector("[data-control=add]").disabled = actions.length >= 10;
      d.querySelector("[data-count]").textContent = `${actions.length} / 10`;
    }
    d.addEventListener("click", (event) => {
      const button = event.target.closest("[data-control]");
      if (!button) return;
      const action = button.dataset.control,
        i = Number(button.dataset.index);
      if (action === "visible") {
        const input = d.querySelector("[name=password]");
        input.type = input.type === "password" ? "text" : "password";
        button.textContent = t(
          input.type === "password" ? "Show password" : "Hide password",
        );
        return;
      }
      if (!["add", "up", "down", "remove"].includes(action)) return;
      readActions();
      if (action === "add" && actions.length < 10) {
        openAction = randomId();
        actions.push({ ...actions[0], id: openAction, label: "" });
      }
      if (action === "remove" && actions.length > 1) {
        actions.splice(i, 1);
        openAction = actions[Math.min(i, actions.length - 1)].id;
      }
      const j = action === "up" ? i - 1 : i + 1;
      if (["up", "down"].includes(action) && actions[j])
        [actions[i], actions[j]] = [actions[j], actions[i]];
      draw();
    });
    d.addEventListener(
      "toggle",
      (event) => {
        if (event.target.matches("[data-button]") && event.target.open)
          openAction = actions[Number(event.target.dataset.button)].id;
      },
      true,
    );
    d.addEventListener("input", (event) => {
      const mapping = event.target.closest("[data-button]");
      if (!mapping) return;
      readActions();
      const a = actions[Number(mapping.dataset.button)];
      mapping.querySelector("[data-button-label]").textContent =
        a.label || t("New button");
      mapping.querySelector("[data-button-mapping]").textContent =
        `${data.receivers.find((r) => r.config.id === a.receiver)?.config.label || t("Output")} ← ${labelFor(data, a.source)}`;
    });
    draw();
  }
  function selector(receiver, initialAll = false) {
    const d = editDialog(
      "Choose a source",
      `<p>${t("Current source")}: ${e(labelFor(data, receiver.state.source))}</p><label class="field">${t("Search sources")}<input type="search" autocomplete="off" data-source-search></label><div class="inline-actions">${b("Saved sources", "saved")}${b("All Sources", "all")}</div><div data-options></div>`,
      () => {},
      "",
    );
    d.classList.add("source-dialog");
    d.querySelector(".dialog-header h2").textContent = receiver.config.label;
    d.querySelector(".dialog-header h2").setAttribute("data-user-content", "");
    d.querySelector(".dialog-footer").remove();
    let query = "",
      showAll = initialAll || !data.saved.length;
    const draw = () => {
      d.querySelector("[data-control=all]").setAttribute(
        "aria-pressed",
        showAll,
      );
      d.querySelector("[data-control=saved]").setAttribute(
        "aria-pressed",
        !showAll,
      );
      const sources = showAll
        ? data.sources.map((s) => ({
            source: s.name,
            display_name: labelFor(data, s.name),
          }))
        : data.saved;
      d.querySelector("[data-options]").innerHTML =
        sources
          .filter((s) =>
            `${s.display_name} ${s.source}`
              .toLowerCase()
              .includes(query.toLowerCase()),
          )
          .map(
            (s) =>
              `<button type="button" class="source-option ${s.source === receiver.state.source ? "active" : ""}" aria-pressed="${s.source === receiver.state.source}" aria-label="${e(s.display_name)}" data-source="${e(s.source)}"><span data-user-content>${e(s.display_name)}${s.display_name !== s.source ? `<small>${e(s.source)}</small>` : ""}</span><span>${s.source === receiver.state.source ? "✓" : ""}</span></button>`,
          )
          .join("") || empty("No matching sources");
    };
    d.querySelector("[data-source-search]").oninput = (event) => {
      query = event.target.value;
      draw();
    };
    d.addEventListener("click", (event) => {
      const x = event.target.closest("button");
      if (!x) return;
      if (x.hasAttribute("data-source")) {
        d.close();
        void route(receiver, x.dataset.source);
      } else if (["all", "saved"].includes(x.dataset.control)) {
        showAll = x.dataset.control === "all";
        draw();
      }
    });
    draw();
  }
  function render() {
    if (disposed || !data) return;
    const markup = controlMarkup(data, page, {
      search,
      sourceSearch,
      working,
      pendingRoute,
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
    const scroll = host.querySelector(".matrix-scroll");
    const scrollLeft = scroll?.scrollLeft || 0,
      scrollTop = scroll?.scrollTop || 0;
    host.innerHTML = markup;
    lastMarkup = markup;
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
      host
        .querySelector(
          `[data-row="${Number(x.dataset.row) + move[0]}"][data-col="${Number(x.dataset.col) + move[1]}"]`,
        )
        ?.focus();
    }
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
        const row = x.closest(".list-row");
        const main = row.querySelector(".list-main");
        main.innerHTML = `<form class="inline-editor">${field("Display name", "display_name", source.display_name, 'required maxlength="64"')}<div class="inline-actions"><button class="primary">${t("Save")}</button>${b("Cancel", "source-cancel")}</div></form>`;
        const form = main.querySelector("form");
        form.querySelector("input").focus();
        form.onsubmit = async (event) => {
          event.preventDefault();
          form.querySelectorAll("button").forEach((b) => (b.disabled = true));
          try {
            await mutate(
              "sources.saved.update",
              { id, display_name: new FormData(form).get("display_name") },
              "",
            );
          } catch (error) {
            toast(error.message, "error", "form-error");
          } finally {
            form
              .querySelectorAll("button")
              .forEach((b) => (b.disabled = false));
          }
        };
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
      if (action === "profile-add") profileEditor();
      if (action === "profile-edit") profileEditor(profile);
      if (action === "profile-delete")
        await mutate(
          "simple.delete",
          { id },
          `${t("Delete this profile and all its buttons? Existing sessions will lose access.")}\n${profile.name}`,
        );
      if (action === "profile-toggle")
        await mutate(
          "simple.update",
          { id, enabled: !profile.enabled },
          `${t(profile.enabled ? "Disable" : "Enable")} ${profile.name}?`,
        );
      if (["profile-up", "profile-down"].includes(action)) {
        const i = data.profiles.indexOf(profile),
          j = action === "profile-up" ? i - 1 : i + 1;
        if (data.profiles[j])
          await mutate(
            "simple.update",
            { id, order: j },
            `${t("Reorder Simple Modes")}: ${profile.name} → ${j + 1}`,
          );
      }
      if (action === "profile-preview") {
        const d = editDialog(
          "Preview",
          `<h2 data-user-content>${e(profile.name)}</h2><div class="simple-grid">${profile.actions.map((a) => `<button type="button" disabled>${e(a.label)}</button>`).join("")}</div>`,
          () => {},
        );
        d.querySelector(".dialog-footer").remove();
      }
      if (action === "event")
        await mutate(
          data.event.enabled ? "event.disable" : "event.enable",
          {},
          data.event.enabled
            ? "Disable Event Mode? Simple Modes will become available again."
            : "Enabling Event Mode will temporarily disable all Simple Modes. Only the administrator will be able to control DRouter.",
        );
      if (action === "pick")
        selector(
          data.receivers.find((r) => r.config.id === id),
          x.dataset.all === "true",
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
  void refresh().catch((error) => {
    if (!disposed) {
      host.textContent = "";
      toast(error.message, "error", "control-error");
    }
  });
  document.addEventListener("drouter-language", render);
  const timer = setInterval(() => {
    if (
      !working &&
      !dialogs.size &&
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
    clearInterval(timer);
    dialogs.forEach((d) => d.close());
    host.onclick = null;
    host.onkeydown = null;
    host.oninput = null;
  };
}
export function mountSimple(host, client, logout) {
  let stopped = false,
    pending = null,
    profile,
    reading = null,
    lastMarkup = "";
  function render() {
    if (stopped || !profile) return;
    const markup = `<main class="simple-screen"><header><strong>DRouter</strong>${languageControl()}${b("Logout", "logout")}</header><div class="simple-heading"><h1 data-user-content>${e(profile.name)}</h1><p data-user-content>${e(profile.description)}</p><span class="status-text"><span class="status-dot"></span>${t("Connected")}</span></div>${profile.locked ? `<div class="notice" role="status"><h2>${t("Event Mode")}</h2><p>${t("Simple Mode is temporarily locked by the administrator.")}</p></div>` : `<div class="simple-grid">${profile.actions.map((a) => b(`${a.icon ? e(a.icon) + " " : ""}${e(a.label)}${pending === a.id ? " · " + t("Switching…") : ""}`, a.id, `data-user-content class="simple-action ${pending === a.id ? "pending" : ""}" ${pending ? "disabled" : ""}`)).join("")}</div>`}</main>`;
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
        logout();
      }
      return;
    }
    if (pending || profile?.locked) return;
    pending = x.dataset.control;
    toast("Switching…", "loading", "simple-routing");
    render();
    try {
      await client.call("simple.action.execute", { id: pending });
      toast("Routing verified", "success", "simple-routing");
    } catch (error) {
      toast(error.message, "error", "simple-routing");
    } finally {
      await refresh().catch(() => logout());
      pending = null;
      render();
    }
  };
  client.onDisconnect = () =>
    logout("Device disconnected. Reconnect to continue.");
  void refresh().catch(() => logout());
  document.addEventListener("drouter-language", render);
  const timer = setInterval(() => {
    if (!pending && !reading && document.visibilityState === "visible")
      void refresh().catch(() => logout());
  }, 2500);
  return () => {
    stopped = true;
    document.removeEventListener("drouter-language", render);
    clearInterval(timer);
    host.onclick = null;
  };
}

function controlMarkup(data, page, state) {
  const { search, sourceSearch, working, pendingRoute } = state;
  const pending = (r, source) =>
    pendingRoute?.receiver === r.config.id && pendingRoute?.source === source;
  const arrow = '<span aria-hidden="true">⌄</span>';
  const searchInput = (label, key, value) =>
    `<label class="search-field ${key === "source" ? "source-filter" : ""}"><span class="sr-only">${t(label)}</span><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><circle cx="10" cy="10" r="6"/><path d="m15 15 5 5"/></svg><input type="search" aria-label="${t(label)}" placeholder="${t(label)}" data-${key}-search data-focus="${key}-search" value="${e(value)}" autocomplete="off"></label>`;
  const order = (kind, item, i, length) =>
    `<div class="order-actions">${b("↑", `${kind}-up`, `data-focus="${kind}-up-${e(item.id)}" aria-label="${t("Move up")} · ${e(item.display_name || item.name)}" data-id="${e(item.id)}" ${i === 0 ? "disabled" : ""}`)}${b("↓", `${kind}-down`, `data-focus="${kind}-down-${e(item.id)}" aria-label="${t("Move down")} · ${e(item.display_name || item.name)}" data-id="${e(item.id)}" ${i === length - 1 ? "disabled" : ""}`)}</div>`;
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
    return `<div class="form-actions">${b("Create Simple Mode", "profile-add", 'class="primary"')}</div><p class="help-text">${t("Each profile has its own password and 1–10 fixed action buttons.")}</p><div class="data-list profile-list">${data.profiles.map((p, i) => `<div class="list-row"><div class="list-main"><strong data-user-content>${e(p.name)}</strong>${p.description ? `<span data-user-content>${e(p.description)}</span>` : ""}<small>${p.actions.length} / 10 · ${t(p.enabled ? "Enabled" : "Disabled")}</small><span class="profile-preview" data-user-content>${p.actions.map((a) => e(a.label)).join(" · ")}</span></div><div class="row-actions">${b("Edit", "profile-edit", `data-id="${e(p.id)}"`)}${b("Preview", "profile-preview", `data-id="${e(p.id)}"`)}${b(p.enabled ? "Disable" : "Enable", "profile-toggle", `data-id="${e(p.id)}"`)}${order("profile", p, i, data.profiles.length)}${b("Delete", "profile-delete", `class="quiet danger" data-id="${e(p.id)}"`)}</div></div>`).join("") || empty("No Simple Modes configured")}</div>`;
  if (page === "Access Control")
    return `<div class="settings-row"><div class="settings-copy">${t("Event Mode")}<span>${t(data.event.enabled ? "Enabled" : "Disabled")}</span></div>${b(data.event.enabled ? "Disable Event Mode" : "Enable Event Mode", "event")}</div><p class="help-text">${t("Enabling Event Mode will temporarily disable all Simple Modes. Only the administrator will be able to control DRouter.")}</p><div class="settings-row"><span>${t("Language")}</span>${languageControl()}</div><div class="settings-row"><span>${t("Contact")}</span><a href="mailto:benedek@dezso.hu">benedek@dezso.hu</a></div>`;
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
  const routeButton = (r, s, ri, ci, mobile = false) =>
    b(
      pending(r, s.source)
        ? '<span class="spinner" aria-hidden="true"></span>'
        : mobile
          ? e(s.display_name)
          : r.state.source === s.source
            ? "✓"
            : "·",
      "route",
      `class="${mobile ? "quick-route" : "crosspoint"} ${r.state.source === s.source ? "active" : ""} ${pending(r, s.source) ? "pending" : ""}" data-focus="${mobile ? "quick" : "matrix"}-${e(r.config.id)}-${e(s.id)}" data-row="${ri}" data-col="${ci}" data-id="${e(r.config.id)}" data-source="${e(s.source)}" aria-label="${e(t("Route {source} to {output}", { source: s.display_name, output: r.config.label }))}" aria-pressed="${r.state.source === s.source}" ${working || !r.state.online ? "disabled" : ""}`,
    );
  const pickerButton = (r, mobile = false) =>
    b(
      `${e(mobile ? t("All Sources") : currentSource(r) && !data.saved.some((s) => s.source === currentSource(r)) ? labelFor(data, currentSource(r)) : t("All Sources"))}${arrow}`,
      "pick",
      `class="${mobile ? "all-sources" : ""}" data-id="${e(r.config.id)}" data-all="true" aria-haspopup="dialog" aria-label="${e(t("All Sources") + " · " + r.config.label)}" ${working || !r.state.online ? "disabled" : ""}`,
    );
  return `<div class="routing-tools">${searchInput("Find an output", "output", search)}${searchInput("Find a source", "source", sourceSearch)}${b("Refresh sources", "refresh", working ? "disabled" : "")}</div>${!receivers.length ? `<div class="empty-state"><h2>${t("No outputs connected")}</h2><p>${t("Add a BirdDog receiver in Devices to start routing.")}</p></div>` : `<div class="matrix-scroll" role="region" aria-label="${t("Routing matrix")}" tabindex="0"><table class="route-table"><thead><tr><th scope="col">${t("Source / output")}</th>${receivers.map((r) => `<th scope="col"><strong data-user-content>${e(r.config.label)}</strong><small class="output-source"><span class="status-dot ${r.state.online ? "" : "offline"}"></span> ${t(r.state.online ? "Online" : "Offline")}<br><span data-user-content>${e(labelFor(data, currentSource(r)))}</span>${!r.state.online && currentSource(r) ? ` · ${t("Last known")}` : ""}</small></th>`).join("")}</tr></thead><tbody>${saved.map((s, ri) => `<tr><th scope="row"><span data-user-content>${e(s.display_name)}</span>${data.sources.some((x) => x.name === s.source) ? "" : `<small class="output-source">${t("Unavailable")}</small>`}</th>${receivers.map((r, ci) => `<td>${routeButton(r, s, ri, ci)}</td>`).join("")}</tr>`).join("")}<tr class="other-source"><th scope="row">${t("All Sources")}</th>${receivers.map((r) => `<td class="${currentSource(r) && !data.saved.some((s) => s.source === currentSource(r)) ? "other-active" : ""}">${pickerButton(r)}</td>`).join("")}</tr></tbody></table></div><div class="matrix-footer"><span><span class="legend-mark">●</span>${t("Verified active source")}</span><span>${t("Select a crosspoint to route")}</span><span>${t("Arrow keys move between crosspoints")}</span></div><div class="output-list">${receivers.map((r, ci) => `<section class="output-row">${b(`<span class="output-text"><strong data-user-content>${e(r.config.label)}</strong><span class="current-route" data-user-content>${e(labelFor(data, currentSource(r)))}</span><span class="status-text"><span class="status-dot ${r.state.online ? "" : "offline"}"></span>${t(r.state.online ? "Online" : "Offline")}${!r.state.online && currentSource(r) ? ` · ${t("Last known")}` : ""}</span></span><span aria-hidden="true">›</span>`, "pick", `class="output-open" aria-label="${e(t("Change source for {output}", { output: r.config.label }))}" data-id="${e(r.config.id)}" ${working || !r.state.online ? "disabled" : ""}`)}<div class="output-quick"><div class="quick-sources" aria-label="${t("Saved sources")}">${data.saved.map((s, ri) => routeButton(r, s, ri, ci, true)).join("")}</div>${pickerButton(r, true)}</div></section>`).join("")}</div>`}`;
}
