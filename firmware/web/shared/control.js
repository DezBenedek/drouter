import { randomId } from "./client.js";
import { t, languageControl, localize } from "./i18n.js";
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
  const d = document.createElement("dialog");
  d.className = "dialog control-dialog";
  d.innerHTML = `<form><header class="dialog-header"><h2>${t(title)}</h2>${b("Close", "close", 'class="quiet"')}</header><div class="dialog-body">${body}<p class="notice error" role="alert" hidden></p></div><footer class="dialog-footer">${b("Cancel", "close")}<button class="primary">${t(action)}</button></footer></form>`;
  d.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      event.preventDefault();
      d.close();
    }
  });
  d.addEventListener("click", (event) => {
    if (event.target === d) d.close();
  });
  document.body.append(d);
  d.querySelectorAll("[data-control=close]").forEach(
    (x) => (x.onclick = () => d.close()),
  );
  d.addEventListener("close", () => d.remove());
  d.querySelector("form").onsubmit = async (event) => {
    event.preventDefault();
    const buttons = [...d.querySelectorAll("button")];
    buttons.forEach((x) => (x.disabled = true));
    try {
      await submit(new FormData(event.currentTarget), d);
    } catch (error) {
      const x = d.querySelector("[role=alert]");
      x.hidden = false;
      x.textContent = t(error.message);
    } finally {
      buttons.forEach((x) => (x.disabled = false));
    }
  };
  localize(d);
  d.showModal();
  return d;
}
export function confirmChange(title, body) {
  return new Promise((resolve) => {
    const d = dialog(
      title,
      `<p>${e(t(body))}</p>`,
      async (_, d) => {
        resolve(true);
        d.close();
      },
      "Confirm",
    );
    d.addEventListener("close", () => resolve(false));
  });
}
const routeCache = new WeakMap();
const currentSource = (r) => r.state.source || r.state.last_source;
async function load(client) {
  const [info, saved, discovered, receivers, profiles, event] =
    await Promise.all(
      [
        "device.info",
        "sources.saved.list",
        "sources.list",
        "receivers.list",
        "simple.list",
        "event.status",
      ].map((op) => client.call(op)),
    );
  let cache = routeCache.get(client);
  if (!cache) {
    cache = new Map();
    routeCache.set(client, cache);
  }
  for (const id of cache.keys())
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
    event,
  };
}
export function mountControl(host, client, page, changed = () => {}) {
  let data,
    disposed = false,
    working = false,
    search = "",
    feedback = "",
    failure = false,
    pendingRoute = null;
  const dialogs = new Set();
  const editDialog = (...args) => {
    const d = dialog(...args);
    dialogs.add(d);
    d.addEventListener("close", () => dialogs.delete(d));
    return d;
  };
  async function refresh() {
    const next = await load(client);
    if (!disposed) {
      data = next;
      render();
    }
  }
  async function mutate(op, params, summary) {
    if (!(await confirmChange("Confirm changes", summary))) return false;
    await client.call(op, {
      ...params,
      confirmed: true,
      expected_revision: data.info.revision,
    });
    await refresh();
    await changed();
    return true;
  }
  async function route(receiver, source) {
    if (working) return;
    working = true;
    pendingRoute = { receiver: receiver.config.id, source };
    feedback = t("Switching…");
    failure = false;
    render();
    try {
      await client.call("route.set", { receiver: receiver.config.id, source });
      feedback = t("Routing verified");
      await refresh();
    } catch (error) {
      feedback = `${receiver.config.label}: ${t(error.message)}`;
      failure = true;
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
    const d = editDialog(
      profile ? "Edit Simple Mode" : "Create Simple Mode",
      `${field("Profile name", "name", profile?.name || "", 'required maxlength="64"')}${field("Description", "description", profile?.description || "", 'maxlength="256"')}<label class="field">${t("Password")}<span class="password-control"><input name="password" aria-label="${t("Password")}" type="password" autocomplete="new-password" ${profile ? "" : "required"}>${b("Show password", "visible")}</span></label><p class="help-text">${t("Use 4–128 Unicode characters. Short passwords are weak; use a longer password when possible.")}</p><label class="field-row"><input type="checkbox" name="enabled" ${profile?.enabled === false ? "" : "checked"}>${t("Enabled")}</label><h3>${t("Action buttons")}</h3><div data-actions></div>${b("Add button", "add")}`,
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
            `<fieldset data-button="${i}"><legend>${t("Button")} ${i + 1}</legend>${field("Label", "label", a.label, 'required maxlength="64"')}${field("Icon (optional)", "icon", a.icon || "", 'maxlength="32"')}<label class="field">${t("Output")}<select name="receiver" required>${data.receivers.map((r) => `<option value="${e(r.config.id)}" ${r.config.id === a.receiver ? "selected" : ""}>${e(r.config.label)}</option>`).join("")}</select></label><label class="field">${t("Source")}<select name="source" required>${[
              ...new Set([...data.sources.map((s) => s.name), a.source]),
            ]
              .filter(Boolean)
              .map(
                (s) =>
                  `<option value="${e(s)}" ${s === a.source ? "selected" : ""}>${e(labelFor(data, s))}</option>`,
              )
              .join(
                "",
              )}</select></label><label class="field-row"><input type="checkbox" name="action-enabled" ${a.enabled ? "checked" : ""}>${t("Enabled")}</label><div class="inline-actions">${b("↑", "up", `data-index="${i}" ${i === 0 ? "disabled" : ""}`)}${b("↓", "down", `data-index="${i}" ${i === actions.length - 1 ? "disabled" : ""}`)}${b("Remove button", "remove", `data-index="${i}" ${actions.length === 1 ? "disabled" : ""}`)}</div></fieldset>`,
        )
        .join("");
      d.querySelector("[data-control=add]").disabled = actions.length >= 10;
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
      if (action === "add" && actions.length < 10)
        actions.push({
          ...actions[0],
          id: randomId(),
          label: "",
        });
      if (action === "remove" && actions.length > 1) actions.splice(i, 1);
      const j = action === "up" ? i - 1 : i + 1;
      if (["up", "down"].includes(action) && actions[j])
        [actions[i], actions[j]] = [actions[j], actions[i]];
      draw();
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
    d.querySelector(".dialog-footer").remove();
    let query = "",
      showAll = initialAll;
    const draw = () => {
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
              `<button type="button" class="source-option ${s.source === receiver.state.source ? "active" : ""}" aria-label="${e(s.display_name)}" data-source="${e(s.source)}"><span data-user-content>${e(s.display_name)}</span><span>${s.source === receiver.state.source ? "✓" : ""}</span></button>`,
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
    const indicator = host
      .closest(".app-shell")
      ?.querySelector(".event-indicator");
    if (indicator) indicator.hidden = !data.event.enabled;
    const notice = feedback
      ? `<p class="notice ${failure ? "error" : "success"}" role="status">${e(feedback)}</p>`
      : "";
    if (page === "Sources")
      host.innerHTML = `<div class="form-actions">${b("Save source", "source-add", 'class="primary"')}${b("Refresh sources", "refresh")}</div><h2>${t("Saved sources")}</h2><div class="data-list">${data.saved.map((s, i) => `<div class="list-row"><div class="list-main"><strong data-user-content>${e(s.display_name)}</strong><small data-user-content>${e(s.original_name)}</small></div><span>${t(data.sources.some((x) => x.name === s.source) ? "Available" : "Unavailable")}</span>${b("Rename", "source-edit", `data-id="${e(s.id)}"`)}${b("↑", "source-up", `data-id="${e(s.id)}" ${i === 0 ? "disabled" : ""}`)}${b("↓", "source-down", `data-id="${e(s.id)}" ${i === data.saved.length - 1 ? "disabled" : ""}`)}${b("Remove", "source-remove", `data-id="${e(s.id)}" class="danger"`)}</div>`).join("") || empty("No saved sources")}</div><h2>${t("Discovered sources")}</h2><div class="data-list">${data.sources.map((s) => `<div class="list-row"><span class="list-main">${e(s.name)}</span>${data.saved.some((x) => x.source === s.name) ? t("Saved") : b("Save source", "source-discovered", `data-source="${e(s.name)}"`)}</div>`).join("")}</div>${notice}`;
    if (page === "Simple Modes")
      host.innerHTML = `<div class="form-actions">${b("Create Simple Mode", "profile-add", 'class="primary"')}</div><p class="help-text">${t("Each profile has its own password and 1–10 fixed action buttons.")}</p><div class="data-list">${data.profiles.map((p) => `<div class="list-row"><div class="list-main"><strong data-user-content>${e(p.name)}</strong><span data-user-content>${e(p.description)}</span><small>${p.actions.length} · ${t(p.enabled ? "Enabled" : "Disabled")}</small></div>${b("Edit", "profile-edit", `data-id="${e(p.id)}"`)}${b("Preview", "profile-preview", `data-id="${e(p.id)}"`)}${b(p.enabled ? "Disable" : "Enable", "profile-toggle", `data-id="${e(p.id)}"`)}${b("↑", "profile-up", `data-id="${e(p.id)}"`)}${b("↓", "profile-down", `data-id="${e(p.id)}"`)}${b("Delete", "profile-delete", `class="danger" data-id="${e(p.id)}"`)}</div>`).join("") || empty("No Simple Modes configured")}</div>${notice}`;
    if (page === "Access Control")
      host.innerHTML = `<div class="settings-row"><div class="settings-copy">${t("Event Mode")}<span>${t(data.event.enabled ? "Enabled" : "Disabled")}</span></div>${b(data.event.enabled ? "Disable Event Mode" : "Enable Event Mode", "event", `class="${data.event.enabled ? "" : "primary"}"`)}</div><p class="help-text">${t("Enabling Event Mode will temporarily disable all Simple Modes. Only the administrator will be able to control DRouter.")}</p><div class="settings-row"><span>${t("Language")}</span>${languageControl()}</div><div class="settings-row"><span>${t("Contact")}</span><a href="mailto:benedek@dezso.hu">benedek@dezso.hu</a></div>${notice}`;
    if (page === "Routing") {
      const receivers = data.receivers.filter((r) =>
        r.config.label.toLowerCase().includes(search.toLowerCase()),
      );
      host.innerHTML = `${notice}<div class="routing-tools"><label class="search-field"><input type="search" placeholder="${t("Find an output")}" data-output-search value="${e(search)}"></label>${b("Refresh sources", "refresh")}</div>${!receivers.length ? empty("No outputs connected") : `<div class="matrix-scroll" role="region" aria-label="${t("Routing matrix")}" tabindex="0"><table class="route-table"><thead><tr><th scope="col">${t("Source / output")}</th>${receivers.map((r) => `<th scope="col"><strong data-user-content>${e(r.config.label)}</strong><small class="output-source">${e(labelFor(data, currentSource(r)))} · ${t(r.state.online ? "Online" : "Offline")}</small></th>`).join("")}</tr></thead><tbody>${data.saved.map((s, ri) => `<tr><th scope="row" class="output-cell"><span data-user-content>${e(s.display_name)}</span>${data.sources.some((x) => x.name === s.source) ? "" : `<small class="output-source">${t("Unavailable")}</small>`}</th>${receivers.map((r, ci) => `<td>${b(pendingRoute?.receiver === r.config.id && pendingRoute?.source === s.source ? '<span class="spinner"></span>' : r.state.source === s.source ? "✓" : "·", "route", `class="crosspoint ${r.state.source === s.source ? "active" : ""} ${pendingRoute?.receiver === r.config.id && pendingRoute?.source === s.source ? "pending" : ""}" data-row="${ri}" data-col="${ci}" data-id="${e(r.config.id)}" data-source="${e(s.source)}" aria-label="${e(t("Route {source} to {output}", { source: s.display_name, output: r.config.label }))}" aria-pressed="${r.state.source === s.source}" ${working || !r.state.online ? "disabled" : ""}`)}</td>`).join("")}</tr>`).join("")}<tr class="other-source"><th scope="row" class="output-cell">${t("Other source")}</th>${receivers.map((r) => `<td class="${currentSource(r) && !data.saved.some((s) => s.source === currentSource(r)) ? "other-active" : ""}">${b(e(currentSource(r) && !data.saved.some((s) => s.source === currentSource(r)) ? labelFor(data, currentSource(r)) : t("All Sources")), "pick", `data-id="${e(r.config.id)}" data-all="true" aria-haspopup="dialog" aria-label="${e(t("All Sources") + " · " + r.config.label)}" ${working || !r.state.online ? "disabled" : ""}`)}</td>`).join("")}</tr></tbody></table></div><div class="output-list">${receivers.map((r) => `<div class="output-row">${b(`<span class="output-text"><strong data-user-content>${e(r.config.label)}</strong><span>${e(labelFor(data, currentSource(r)))}</span><span>${t(r.state.online ? "Online" : "Offline")}</span></span><span>›</span>`, "pick", `class="output-open" aria-label="${e("Change source for " + r.config.label)}" data-id="${e(r.config.id)}" ${working || !r.state.online ? "disabled" : ""}`)}</div>`).join("")}</div>`}`;
      host.querySelector("[data-output-search]").oninput = (event) => {
        search = event.target.value;
        render();
        const input = host.querySelector("[data-output-search]");
        input.focus();
      };
    }
    localize(host);
  }
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
      if (action === "source-edit") sourceEditor(source);
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
        await client.call("sources.refresh");
        await refresh();
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
          `<h2>${e(profile.name)}</h2><div class="simple-grid">${profile.actions.map((a) => `<button type="button" disabled>${e(a.label)}</button>`).join("")}</div>`,
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
      feedback = t(error.message);
      failure = true;
      render();
    }
  };
  void refresh().catch((error) => {
    if (!disposed) host.textContent = t(error.message);
  });
  document.addEventListener("drouter-language", render);
  const timer = setInterval(() => {
    if (!working && !dialogs.size && document.visibilityState === "visible")
      void refresh().catch(() => {});
  }, 10000);
  return () => {
    disposed = true;
    document.removeEventListener("drouter-language", render);
    clearInterval(timer);
    dialogs.forEach((d) => d.close());
    host.onclick = null;
    host.onkeydown = null;
  };
}
export function mountSimple(host, client, logout) {
  let stopped = false,
    pending = null,
    result = "",
    failed = false,
    profile,
    lastMarkup = "";
  function render() {
    if (stopped || !profile) return;
    const markup = `<main class="simple-screen"><header><strong>DRouter</strong>${languageControl()}${b("Logout", "logout")}</header><div class="simple-heading"><h1 data-user-content>${e(profile.name)}</h1><p data-user-content>${e(profile.description)}</p><span class="status-text"><span class="status-dot"></span>${t("Connected")}</span></div>${profile.locked ? `<div class="notice" role="status"><h2>${t("Event Mode")}</h2><p>${t("Simple Mode is temporarily locked by the administrator.")}</p></div>` : `<div class="simple-grid">${profile.actions.map((a) => b(`${a.icon ? e(a.icon) + " " : ""}${e(a.label)}${pending === a.id ? " · " + t("Switching…") : ""}`, a.id, `data-user-content class="simple-action ${pending === a.id ? "pending" : ""}" ${pending ? "disabled" : ""}`)).join("")}</div>`}${result ? `<p class="notice ${failed ? "error" : "success"}" role="status">${e(result)}</p>` : ""}</main>`;
    if (markup !== lastMarkup) {
      host.innerHTML = markup;
      lastMarkup = markup;
    }
  }
  async function refresh() {
    profile = await client.call("simple.actions.list");
    render();
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
    result = "";
    render();
    try {
      await client.call("simple.action.execute", { id: pending });
      failed = false;
      result = t("Routing verified");
    } catch (error) {
      failed = true;
      result = t(error.message);
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
    if (!pending) void refresh().catch(() => logout());
  }, 2500);
  return () => {
    stopped = true;
    document.removeEventListener("drouter-language", render);
    clearInterval(timer);
    host.onclick = null;
  };
}
