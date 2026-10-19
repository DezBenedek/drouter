import {
  mountControl,
  mountSimple,
  toggleEvent,
  confirmChange,
  toast,
  dismissToast,
} from "../../../firmware/web/shared/control.js";
import { installLocalization } from "../../../firmware/web/shared/i18n.js";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import {
  ArrowDown,
  ArrowLeft,
  ArrowUp,
  ChevronRight,
  GripVertical,
  ListVideo,
  LogOut,
  Monitor,
  Moon,
  MoreHorizontal,
  Plus,
  RefreshCw,
  Settings as SettingsIcon,
  SlidersHorizontal,
  Sun,
} from "lucide-react";
import { Client, remoteStatus } from "../../../firmware/web/shared/client.js";
import { theme, toggleTheme } from "../../../firmware/web/shared/theme.js";
import "../../../firmware/web/shared/style.css";
import {
  Brand,
  Button,
  Empty,
  Field,
  Modal,
  Password,
  SearchField,
  SettingRow,
  Spinner,
  Status,
} from "./primitives";
import {
  relativeTime,
  snapshot,
  type DeviceClient,
  type Preset,
  type Profile,
  type Receiver,
  type Snapshot,
} from "./model";
type DialogSpec = {
  title: string;
  description?: string;
  body: ReactNode;
  action: string;
  destructive?: boolean;
  submit: (f: Record<string, FormDataEntryValue>) => Promise<void>;
};
const pages = [
  { name: "Routing", icon: SlidersHorizontal },
  { name: "Sources", icon: ListVideo },
  { name: "Simple Modes", icon: Monitor },
  { name: "Devices", icon: Monitor },
  { name: "Presets", icon: ListVideo },
  { name: "Settings", icon: SettingsIcon },
];
function useFeedback(message: string, kind: string) {
  useEffect(() => {
    if (message) toast(message, kind);
  }, [message, kind]);
}
function App() {
  const [session, setSession] = useState<{
      client: DeviceClient;
      data: Snapshot;
    } | null>(null),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [appearance, setAppearance] = useState(theme());
  const [restricted, setRestricted] = useState<DeviceClient | null>(null);
  const [feedbackKind, setFeedbackKind] = useState("error");
  useFeedback(error, feedbackKind);
  const initialName = new URLSearchParams(location.search).get("device") || "";
  function disconnect(message = "", kind = "error") {
    dismissToast();
    if (session) {
      session.client.onDisconnect = () => {};
      session.client.close();
    }
    restricted?.close();
    setRestricted(null);
    setSession(null);
    setError(message);
    setFeedbackKind(kind);
  }
  if (restricted)
    return <SimpleScreen client={restricted} logout={disconnect} />;
  if (session)
    return (
      <Workspace
        initial={session.data}
        client={session.client}
        logout={disconnect}
        appearance={appearance}
        changeTheme={() => setAppearance(toggleTheme())}
      />
    );
  return (
    <main className="auth-screen">
      <div className="auth-panel">
        <div className="auth-brand">
          <Brand />
        </div>
        <h1>Connect to your DRouter</h1>
        <p>Enter your device name and password.</p>
        <form
          onSubmit={async (e) => {
            e.preventDefault();
            const f = new FormData(e.currentTarget);
            setBusy(true);
            setError("");
            setFeedbackKind("error");
            const client = new Client();
            try {
              await client.open(
                String(f.get("name")).trim().toLowerCase(),
                String(f.get("password")),
              );
              const role = await client.call("auth.session");
              if (role.role === "simple_mode") {
                setRestricted(client);
                return;
              }
              const data = await snapshot(client);
              setSession({ client, data });
            } catch {
              client.close();
              setError(
                "Unable to connect. Check your device name, password, and connection.",
              );
            } finally {
              setBusy(false);
            }
          }}
        >
          <Field
            name="name"
            label="Device name"
            defaultValue={initialName}
            autoComplete="username"
            autoCapitalize="none"
            spellCheck={false}
            required
          />
          <Password name="password" autoComplete="current-password" required />
          <button className="primary auth-submit" disabled={busy}>
            {busy ? (
              <>
                <Spinner />
                Connecting…
              </>
            ) : (
              "Connect"
            )}
          </button>
        </form>
        <footer className="auth-foot">
          <span>Password verified on your device</span>
          <Button
            variant="quiet icon-button"
            aria-label="Change appearance"
            onClick={() => setAppearance(toggleTheme())}
          >
            {appearance === "dark" ? <Sun /> : <Moon />}
          </Button>
        </footer>
      </div>
    </main>
  );
}
function Workspace({
  initial,
  client,
  logout: leave,
  appearance,
  changeTheme,
}: {
  initial: Snapshot;
  client: DeviceClient;
  logout: (message?: string, kind?: string) => void;
  appearance: string;
  changeTheme: () => void;
}) {
  const [data, setData] = useState(initial),
    [page, setPage] = useState("Routing"),
    [more, setMore] = useState(false),
    [eventBusy, setEventBusy] = useState(false),
    [section, setSection] = useState<string | null>(null),
    [busy, setBusy] = useState(false),
    [message, setMessage] = useState(""),
    [error, setError] = useState(""),
    [dialog, setDialog] = useState<DialogSpec | null>(null),
    [outputSearch, setOutputSearch] = useState("");
  useFeedback(error, "error");
  useFeedback(message, "success");
  const working = useRef(false);
  const ended = useRef(false);
  function logout(message = "", kind = "success") {
    ended.current = true;
    client.onDisconnect = () => {};
    leave(message, kind);
  }
  const drag = useRef<string | null>(null);
  async function refresh() {
    const next = await snapshot(client);
    setData(next);
    return next;
  }
  useEffect(() => {
    client.onDisconnect = () =>
      logout("Device disconnected. Reconnect to view live routing.", "error");
    const timer = setInterval(() => {
      if (
        !working.current &&
        !["Routing", "Sources", "Simple Modes"].includes(page) &&
        !(page === "Settings" && section === "Access Control") &&
        !document.querySelector("form:focus-within") &&
        document.visibilityState === "visible"
      ) {
        working.current = true;
        void refresh()
          .catch(() => {})
          .finally(() => {
            working.current = false;
          });
      }
    }, 10000);
    return () => {
      clearInterval(timer);
      client.onDisconnect = () => {};
    };
  }, [page, section]);
  useEffect(() => {
    const receive = (event: Event) => {
      const info = (event as CustomEvent).detail;
      setData((old) =>
        old.info.revision === info.revision &&
        old.info.event_mode === info.event_mode
          ? old
          : { ...old, info },
      );
    };
    document.addEventListener("drouter-info", receive);
    return () => document.removeEventListener("drouter-info", receive);
  }, []);
  async function act(task: () => Promise<void>, close = true) {
    if (working.current) return;
    working.current = true;
    setBusy(true);
    setError("");
    setMessage("");
    try {
      await task();
      if (ended.current) return;
      await refresh();
      if (close) setDialog(null);
    } catch (e) {
      if (ended.current) return;
      setError((e as Error).message);
      try {
        await refresh();
      } catch {}
    } finally {
      working.current = false;
      setBusy(false);
    }
  }
  function open(spec: DialogSpec) {
    setError("");
    setDialog(spec);
  }
  const call = (op: string, params: unknown = {}) => client.call(op, params);
  function savePreset() {
    open({
      title: "Save current routing",
      description: "Capture the sources currently reported by your receivers.",
      body: (
        <Field
          name="name"
          label="Preset name"
          autoFocus
          required
          maxLength={64}
        />
      ),
      action: "Save preset",
      submit: async (f) => {
        await call("presets.create", { name: f.name });
        setMessage("Preset saved on your DRouter.");
      },
    });
  }
  function applyPreset(p: Preset) {
    const perform = async () => {
      const result = await call("presets.apply", { id: p.id });
      const report = result.results
        .map(
          (x: any) =>
            `${data.receivers.find((r) => r.config.id === x.receiver)?.config.label || x.receiver}: ${x.ok ? "Verified" : x.error}`,
        )
        .join("\n");
      if (result.results.some((x: any) => !x.ok)) {
        setError(report);
        setMessage("");
      } else setMessage(report);
    };
    if (p.routes.length > 1)
      open({
        title: `Apply ${p.name}?`,
        description: `This changes routing on ${p.routes.length} outputs.`,
        body: <PresetRoutes preset={p} data={data} />,
        action: "Apply preset",
        submit: perform,
      });
    else void act(perform);
  }
  function rename(kind: "receivers" | "presets", id: string, name: string) {
    open({
      title: kind === "receivers" ? "Rename output" : "Rename preset",
      body: (
        <Field
          label="Name"
          name="name"
          defaultValue={name}
          required
          maxLength={64}
          autoFocus
        />
      ),
      action: "Save name",
      submit: async (f) => {
        await call(
          kind === "receivers" ? "receivers.rename" : "presets.update",
          { id, name: f.name },
        );
      },
    });
  }
  function remove(kind: "receivers" | "presets", id: string, name: string) {
    open({
      title: `Remove ${name}?`,
      description:
        kind === "receivers"
          ? "The receiver will stop appearing in this workspace. Saved presets retain their existing output references."
          : "This removes the saved preset from your DRouter.",
      body: null,
      action: "Remove",
      destructive: true,
      submit: async () => {
        await call(
          kind === "receivers" ? "receivers.remove" : "presets.delete",
          { id },
        );
      },
    });
  }
  function addReceiver() {
    open({
      title: "Add BirdDog receiver",
      description: "Connect a decoder on your DRouter’s local network.",
      body: (
        <>
          <Field
            name="label"
            label="Output name"
            placeholder="Studio monitor"
            required
            autoFocus
            maxLength={64}
          />
          <Field
            name="ip"
            label="IP address"
            placeholder="192.168.100.10"
            inputMode="decimal"
            required
          />
          <details className="disclosure">
            <summary>Advanced connection settings</summary>
            <div className="form-grid">
              <Field
                label="API port"
                name="port"
                type="number"
                min={1}
                max={65535}
                defaultValue={8080}
              />
              <Field
                label="Channel"
                name="channel"
                type="number"
                min={1}
                max={4}
                defaultValue={1}
              />
            </div>
          </details>
        </>
      ),
      action: "Add receiver",
      submit: async (f) => {
        await call("receivers.add", {
          id: crypto.randomUUID().slice(0, 8),
          label: f.label,
          ip: f.ip,
          port: Number(f.port || 8080),
          channel: Number(f.channel || 1),
        });
      },
    });
  }
  function needsWifiWarning(id: string) {
    return (
      data.network.wifi.active === id &&
      !(data.network.ethernet.link && data.network.ethernet.ip)
    );
  }
  function wifiChange(op: string, params: any, profile: Profile) {
    const task = async () => {
      await call(op, { ...params, confirm_disconnect: true });
    };
    if (
      op === "wifi.remove" ||
      needsWifiWarning(
        op === "wifi.connect" ? data.network.wifi.active : profile.id,
      )
    )
      open({
        title:
          op === "wifi.remove"
            ? "Remove network?"
            : "Change the active Wi-Fi connection?",
        description:
          op === "wifi.remove" && !needsWifiWarning(profile.id)
            ? "This removes the saved network and its password."
            : "Remote access may disconnect. Keep local Ethernet or the physical recovery process available before continuing.",
        body: (
          <p className="secondary">
            Your saved routing and presets stay on the device.
          </p>
        ),
        action: "Continue",
        submit: task,
      });
    else void act(task);
  }
  function editWifi(profile?: Profile) {
    open({
      title: profile ? "Edit Wi-Fi network" : "Add Wi-Fi network",
      description: "Credentials are stored only on your DRouter.",
      body: (
        <>
          <Field
            name="ssid"
            label="Network name (SSID)"
            defaultValue={profile?.ssid || ""}
            maxLength={32}
            required
            autoFocus
            autoComplete="off"
          />
          <Password
            name="password"
            label="Wi-Fi password"
            autoComplete="new-password"
            required={!profile}
            minLength={profile ? undefined : 8}
            maxLength={63}
            hint={
              profile
                ? "Leave empty to keep the saved password."
                : "WPA2-Personal · 8–63 characters"
            }
          />
          {profile && needsWifiWarning(profile.id) && (
            <p className="help-text">
              Editing this connection may interrupt remote access. Make sure
              local recovery is available.
            </p>
          )}
        </>
      ),
      action: profile ? "Save changes" : "Add network",
      submit: async (f) => {
        await call("wifi.add", {
          id: profile?.id || crypto.randomUUID().slice(0, 8),
          ssid: f.ssid,
          ...(f.password ? { password: f.password } : {}),
          enabled: profile?.enabled ?? true,
          priority: profile?.priority ?? data.wifi.length,
          confirm_disconnect: !!profile && needsWifiWarning(profile.id),
        });
      },
    });
  }
  async function reorder(ids: string[]) {
    await act(async () => {
      await call("wifi.reorder", { ids });
    });
  }
  function moveWifi(id: string, direction: number) {
    const ids = data.wifi.map((w) => w.id),
      index = ids.indexOf(id),
      next = index + direction;
    if (next < 0 || next >= ids.length) return;
    [ids[index], ids[next]] = [ids[next], ids[index]];
    void reorder(ids);
  }
  function general() {
    open({
      title: "Rename DRouter",
      description:
        "The device identity stays unchanged. Existing cloud names remain reserved to this device.",
      body: (
        <Field
          label="Device name"
          name="name"
          defaultValue={data.info.name}
          autoComplete="off"
          required
          pattern="[a-z0-9]+(-[a-z0-9]+)*"
          minLength={3}
          maxLength={32}
          autoFocus
        />
      ),
      action: "Save name",
      submit: async (f) => {
        await call("settings.update", {
          name: f.name,
          expected_revision: data.info.revision,
        });
        logout("Name saved. Reconnect using the new device name.");
      },
    });
  }
  function password() {
    open({
      title: "Change administrator password",
      description: "All local and remote sessions will be revoked.",
      body: (
        <Password
          name="password"
          label="New password"
          autoComplete="new-password"
          required
          autoFocus
          hint="Use 4–128 Unicode characters. Short passwords are weak; use a longer password when possible."
        />
      ),
      action: "Change password",
      submit: async (f) => {
        await call("settings.update", {
          expected_revision: data.info.revision,
          password: f.password,
        });
        logout("Password changed. Reconnect with your new password.");
      },
    });
  }
  function remoteToggle(enabled: boolean) {
    open({
      title: enabled ? "Enable remote access?" : "Disable remote access?",
      description: enabled
        ? "Your DRouter will reserve its name and connect automatically. No cloud account is needed."
        : "Local routing stays available. The registered name remains reserved to this device.",
      body: null,
      action: enabled ? "Enable remote access" : "Disable remote access",
      submit: async () => {
        await call("settings.update", {
          expected_revision: data.info.revision,
          cloud_enabled: enabled,
        });
        logout("Remote access updated. Reconnect to continue.");
      },
    });
  }
  const filteredReceivers = data.receivers.filter((r) =>
    `${r.config.label} ${r.config.ip}`
      .toLowerCase()
      .includes(outputSearch.toLowerCase()),
  );
  const settingsSections = [
    "General",
    "Access Control",
    "Ethernet",
    "Wi-Fi",
    "Remote Access",
    "Security",
    "System",
  ];
  const currentSection = section || "General";
  function deviceDetail(r: Receiver) {
    open({
      title: r.config.label,
      description: "BirdDog decoder",
      body: (
        <>
          <SettingRow title="Address">
            <span className="mono">
              {r.config.ip}:{r.config.port}
            </span>
          </SettingRow>
          <SettingRow title="Connection">
            <Status online={r.state.online}>
              {r.state.online ? "Online" : "Offline"}
            </Status>
          </SettingRow>
          <SettingRow title="Current source">
            <span className="secondary">{r.state.source || "Unavailable"}</span>
          </SettingRow>
          <SettingRow title="Channel">
            <span className="mono">{r.config.channel}</span>
          </SettingRow>
          <div className="form-actions">
            <Button
              onClick={() => rename("receivers", r.config.id, r.config.label)}
            >
              Rename
            </Button>
            <Button
              variant="danger"
              onClick={() => remove("receivers", r.config.id, r.config.label)}
            >
              Remove receiver
            </Button>
          </div>
        </>
      ),
      action: "Done",
      submit: async () => {},
    });
  }
  return (
    <div className="app-shell">
      <a className="skip-link" href="#main">
        Skip to content
      </a>
      <header className="app-topbar">
        <Brand />
        <div className="app-device">
          <strong data-user-content>{data.info.name}</strong>
          <span className="secondary">Remote control</span>
        </div>
        <div className="topbar-actions">
          <Button
            className="event-toggle"
            role="switch"
            aria-label="Event Mode"
            aria-checked={!!data.info.event_mode}
            disabled={eventBusy || busy}
            onClick={async () => {
              setEventBusy(true);
              try {
                await toggleEvent(client);
              } catch (e) {
                setError((e as Error).message);
              } finally {
                setEventBusy(false);
              }
            }}
          >
            <span>Event Mode</span>
            <span className="switch-track" aria-hidden="true" />
          </Button>
          <span className="connection">
            <span className="status-dot" />
            Live device connection
          </span>
          <Button
            variant="quiet icon-button"
            aria-label="Change appearance"
            onClick={changeTheme}
          >
            {appearance === "dark" ? <Sun /> : <Moon />}
          </Button>
          <Button
            variant="quiet icon-button"
            aria-label="Disconnect"
            onClick={() => logout()}
          >
            <LogOut />
          </Button>
        </div>
      </header>
      <nav className="app-nav" aria-label="Main navigation">
        {pages.map((p) => (
          <Button
            key={p.name}
            data-nav={p.name}
            aria-current={page === p.name ? "page" : undefined}
            onClick={() => {
              setPage(p.name);
              setMore(false);
              setSection(null);
              setError("");
              setMessage("");
            }}
          >
            <p.icon />
            <span>{p.name}</span>
          </Button>
        ))}
        <Button
          className="mobile-more"
          aria-expanded={more}
          aria-current={
            ["Devices", "Simple Modes"].includes(page) ? "page" : undefined
          }
          onClick={() => setMore(!more)}
        >
          <MoreHorizontal />
          <span>More</span>
        </Button>
        <div className="nav-footer">
          Standalone by design
          <br />
          DRouter {data.info.version}
        </div>
      </nav>
      {more && (
        <div className="more-menu">
          {pages
            .filter((p) => ["Devices", "Simple Modes"].includes(p.name))
            .map((p) => (
              <Button
                key={p.name}
                onClick={() => {
                  setPage(p.name);
                  setMore(false);
                  setError("");
                  setMessage("");
                }}
              >
                <p.icon />
                <span>{p.name}</span>
              </Button>
            ))}
          <Button
            onClick={() => {
              setPage("Settings");
              setSection("Wi-Fi");
              setMore(false);
            }}
          >
            <SettingsIcon />
            Wi-Fi
          </Button>
          <div className="more-preferences">
            <span data-language-host />
            <Button variant="quiet" onClick={changeTheme}>
              Change appearance
            </Button>
          </div>
        </div>
      )}
      <main id="main" className="app-main">
        <header className="page-header">
          <div className="page-heading">
            <h1>{page}</h1>
            <p className="secondary">
              {page === "Routing"
                ? "Select a source for each output"
                : page === "Devices"
                  ? "BirdDog receivers on your network"
                  : page === "Presets"
                    ? "Routing arrangements saved on this device"
                    : page === "Sources"
                      ? "Choose the sources that appear in Routing"
                      : page === "Simple Modes"
                        ? "Focused controls for your team"
                        : "Device preferences and connectivity"}
            </p>
          </div>
          <div className="page-actions">
            {page === "Routing" && data.presets.length > 0 && (
              <select
                aria-label="Quick apply preset"
                value=""
                onChange={(e) => {
                  const p = data.presets.find((p) => p.id === e.target.value);
                  if (p) applyPreset(p);
                }}
                disabled={busy}
              >
                <option value="">Preset…</option>
                {data.presets.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
            )}
            {page === "Devices" && (
              <Button variant="primary" disabled={busy} onClick={addReceiver}>
                <Plus />
                Add receiver
              </Button>
            )}
            {page === "Presets" && (
              <Button
                variant="primary"
                disabled={busy || !data.receivers.length}
                onClick={savePreset}
              >
                <Plus />
                Save current
              </Button>
            )}
          </div>
        </header>
        {page === "Routing" && <SharedControl client={client} page="Routing" />}
        {["Sources", "Simple Modes"].includes(page) && (
          <SharedControl key={page} client={client} page={page} />
        )}

        {page === "Devices" && (
          <div className="page-body">
            <div className="routing-tools">
              <SearchField
                label="Search devices"
                value={outputSearch}
                onChange={setOutputSearch}
                placeholder="Find a receiver"
              />
              <Button
                disabled={busy}
                onClick={() =>
                  void act(async () => {
                    const found = await call("receivers.discover");
                    for (const receiver of found)
                      await call("receivers.add", receiver);
                    setMessage(
                      found.length
                        ? `${found.length} verified receivers added.`
                        : "No receivers found. You can add a receiver by IP.",
                    );
                  }, false)
                }
              >
                <RefreshCw />
                Discover
              </Button>
            </div>
            <div className="data-list">
              <div className="list-row list-labels">
                <span className="list-main">Receiver</span>
                <span className="address">Address</span>
                <span className="status-text">Status</span>
                <span className="route-name">Current source</span>
                <span className="list-trailing" />
              </div>
              {filteredReceivers.map((r) => (
                <div className="list-row" key={r.config.id}>
                  <div className="list-main">
                    <strong data-user-content>{r.config.label}</strong>
                    <span className="secondary">
                      {r.model || "BirdDog decoder"}
                      <span className="mobile-only mobile-address">
                        {r.config.ip}
                      </span>
                    </span>
                  </div>
                  <span className="address mono">{r.config.ip}</span>
                  <Status online={r.state.online}>
                    {r.state.online ? "Online" : "Offline"}
                  </Status>
                  <span className="route-name secondary">
                    {r.state.source || "Unavailable"}
                  </span>
                  <div className="row-actions">
                    <Button
                      onClick={() =>
                        rename("receivers", r.config.id, r.config.label)
                      }
                    >
                      Rename
                    </Button>
                    <Button variant="quiet" onClick={() => deviceDetail(r)}>
                      Details
                    </Button>
                    <Button
                      variant="quiet danger"
                      onClick={() =>
                        remove("receivers", r.config.id, r.config.label)
                      }
                    >
                      Remove
                    </Button>
                  </div>
                </div>
              ))}
            </div>
            {!data.receivers.length && (
              <Empty
                title="Add your first receiver"
                description="Discover compatible devices or register a BirdDog receiver by IP."
              >
                <Button onClick={addReceiver}>Add receiver</Button>
              </Empty>
            )}
          </div>
        )}
        {page === "Presets" && (
          <div className="page-body">
            <div className="data-list">
              {data.presets.map((p) => (
                <div className="list-row" key={p.id}>
                  <div className="list-main">
                    <Button
                      className="preset-name"
                      onClick={() =>
                        open({
                          title: p.name,
                          description: `${p.routes.length} saved output connections`,
                          body: <PresetRoutes preset={p} data={data} />,
                          action: "Done",
                          submit: async () => {},
                        })
                      }
                    >
                      {p.name}
                    </Button>
                    <span className="preset-detail">
                      {p.routes.length} outputs
                    </span>
                  </div>
                  <Button disabled={busy} onClick={() => applyPreset(p)}>
                    Apply
                  </Button>
                  <div className="row-actions">
                    <Button onClick={() => rename("presets", p.id, p.name)}>
                      Rename
                    </Button>
                    <Button
                      variant="quiet danger"
                      onClick={() => remove("presets", p.id, p.name)}
                    >
                      Delete
                    </Button>
                  </div>
                </div>
              ))}
            </div>
            {!data.presets.length && (
              <Empty
                title="Save a routing arrangement"
                description="Presets capture verified output sources and are stored on your DRouter."
              >
                <Button onClick={savePreset} disabled={!data.receivers.length}>
                  Save current routing
                </Button>
              </Empty>
            )}
          </div>
        )}
        {page === "Settings" && (
          <div className="page-body">
            <div
              className="settings-layout"
              data-section={section || undefined}
            >
              <nav className="settings-nav" aria-label="Settings sections">
                {settingsSections.map((s) => (
                  <Button
                    key={s}
                    aria-current={currentSection === s ? "page" : undefined}
                    onClick={() => setSection(s)}
                  >
                    {s}
                    <ChevronRight className="mobile-only" />
                  </Button>
                ))}
              </nav>
              <section className="settings-section">
                <Button
                  className="settings-back"
                  onClick={() => setSection(null)}
                >
                  <ArrowLeft />
                  Settings
                </Button>
                <h2>{currentSection}</h2>
                <p className="section-caption">
                  {
                    (
                      {
                        General: "The name and identity of this DRouter.",
                        Ethernet:
                          "The wired connection to your BirdDog network.",
                        "Wi-Fi":
                          "Networks are tried from highest to lowest priority.",
                        "Remote Access":
                          "Connect securely from outside your local network.",
                        Security: "Your device is the only password authority.",
                        System: "Software, storage, and recovery.",
                      } as any
                    )[currentSection]
                  }
                </p>
                {currentSection === "Access Control" && (
                  <SharedControl client={client} page="Access Control" />
                )}
                {currentSection === "General" && (
                  <div className="settings-group">
                    <SettingRow
                      title="Device name"
                      detail="Also used for remote login"
                    >
                      <span className="inline-actions">
                        <span>{data.info.name}</span>
                        <Button onClick={general}>Change</Button>
                      </span>
                    </SettingRow>
                    <SettingRow title="Appearance">
                      <select
                        aria-label="Appearance"
                        value={appearance}
                        onChange={() => changeTheme()}
                      >
                        <option value="light">Light</option>
                        <option value="dark">Dark</option>
                      </select>
                    </SettingRow>
                    <SettingRow
                      title="Device identity"
                      detail="Stays the same across renames"
                    >
                      <span className="mono secondary">
                        {data.info.device_id?.slice(0, 16)}…
                      </span>
                    </SettingRow>
                  </div>
                )}
                {currentSection === "Ethernet" && (
                  <>
                    <SettingRow title="Connection">
                      <Status online={data.network.ethernet.link}>
                        {data.network.ethernet.ip || "Disconnected"}
                      </Status>
                    </SettingRow>
                    <form
                      className="settings-group"
                      onSubmit={(e) => {
                        e.preventDefault();
                        const f = Object.fromEntries(
                          new FormData(e.currentTarget),
                        );
                        void act(async () => {
                          if (
                            !(await confirmChange(
                              "Change network settings?",
                              "This may interrupt your connection. Keep local Ethernet or physical recovery access available.",
                            ))
                          )
                            return;
                          await call("settings.update", {
                            expected_revision: data.info.revision,
                            ethernet: Object.fromEntries(
                              ["address", "mask", "gateway", "dns"].map((k) => [
                                k,
                                f[k] || null,
                              ]),
                            ),
                          });
                          setMessage("Ethernet settings saved.");
                        }, false);
                      }}
                    >
                      <div className="form-grid form-spaced">
                        <Field
                          label="IPv4 address"
                          name="address"
                          defaultValue={data.info.ethernet_config.address || ""}
                          placeholder="Automatic (DHCP)"
                          inputMode="decimal"
                          hint="Leave empty to use DHCP."
                        />
                        <Field
                          label="Subnet mask"
                          name="mask"
                          defaultValue={data.info.ethernet_config.mask || ""}
                          placeholder="255.255.255.0"
                          inputMode="decimal"
                        />
                        <Field
                          label="Gateway"
                          name="gateway"
                          defaultValue={data.info.ethernet_config.gateway || ""}
                          inputMode="decimal"
                        />
                        <Field
                          label="DNS server"
                          name="dns"
                          defaultValue={data.info.ethernet_config.dns || ""}
                          inputMode="decimal"
                        />
                      </div>
                      <div className="form-actions">
                        <button className="primary" disabled={busy}>
                          Save Ethernet
                        </button>
                      </div>
                    </form>
                  </>
                )}
                {currentSection === "Wi-Fi" && (
                  <>
                    <div className="inline-actions">
                      <Button onClick={() => editWifi()} disabled={busy}>
                        <Plus />
                        Add network
                      </Button>
                    </div>
                    <div className="data-list list-spaced">
                      {data.wifi.map((w, index) => (
                        <div
                          className={`wifi-row ${w.enabled ? "" : "disabled"}`}
                          key={w.id}
                          draggable={matchMedia("(pointer:fine)").matches}
                          onDragStart={(e) => {
                            drag.current = w.id;
                            e.dataTransfer.setData("text/plain", w.id);
                          }}
                          onDragOver={(e) => e.preventDefault()}
                          onDrop={(e) => {
                            e.preventDefault();
                            const from = drag.current;
                            if (!from || from === w.id) return;
                            const ids = data.wifi
                              .map((p) => p.id)
                              .filter((id) => id !== from);
                            ids.splice(index, 0, from);
                            void reorder(ids);
                            drag.current = null;
                          }}
                        >
                          <GripVertical className="wifi-drag" />
                          <span className="priority">{index + 1}</span>
                          <div className="wifi-copy">
                            <strong data-user-content>{w.ssid}</strong>
                            <span className="secondary">
                              {data.network.wifi.active === w.id &&
                              data.network.wifi.connected
                                ? "Connected"
                                : w.enabled
                                  ? "Saved"
                                  : "Disabled"}
                            </span>
                          </div>
                          <div className="wifi-actions">
                            <Button
                              variant="quiet icon-button"
                              aria-label={`Move ${w.ssid} up`}
                              disabled={busy || index === 0}
                              onClick={() => moveWifi(w.id, -1)}
                            >
                              <ArrowUp />
                            </Button>
                            <Button
                              variant="quiet icon-button"
                              aria-label={`Move ${w.ssid} down`}
                              disabled={busy || index === data.wifi.length - 1}
                              onClick={() => moveWifi(w.id, 1)}
                            >
                              <ArrowDown />
                            </Button>
                            <Button
                              variant="quiet"
                              className="edit-network"
                              onClick={() => editWifi(w)}
                            >
                              Edit
                            </Button>
                            <input
                              type="checkbox"
                              role="switch"
                              aria-label={`Enable ${w.ssid}`}
                              checked={w.enabled}
                              disabled={busy}
                              onChange={(e) =>
                                wifiChange(
                                  "wifi.set_enabled",
                                  { id: w.id, enabled: e.target.checked },
                                  w,
                                )
                              }
                            />
                            <Button
                              variant="quiet"
                              disabled={busy || !w.enabled}
                              onClick={() =>
                                wifiChange("wifi.connect", { id: w.id }, w)
                              }
                            >
                              Reconnect
                            </Button>
                            <Button
                              variant="quiet danger"
                              disabled={busy}
                              onClick={() =>
                                wifiChange("wifi.remove", { id: w.id }, w)
                              }
                            >
                              Remove
                            </Button>
                          </div>
                        </div>
                      ))}
                    </div>
                    <p className="help-text">
                      Saved passwords are never returned to this interface. Drag
                      rows to reorder on desktop, or use the arrow controls.
                    </p>
                    <details className="disclosure">
                      <summary>Priority behavior</summary>
                      <form
                        onSubmit={(e) => {
                          e.preventDefault();
                          const f = new FormData(e.currentTarget);
                          void act(async () => {
                            await call("settings.update", {
                              expected_revision: data.info.revision,
                              wifi_policy: {
                                preferred_check_secs: Number(
                                  f.get("preferred"),
                                ),
                                retry_secs: Number(f.get("retry")),
                                prefer_higher: f.has("prefer"),
                              },
                            });
                          }, false);
                        }}
                      >
                        <Field
                          label="Preferred network check interval (seconds)"
                          type="number"
                          name="preferred"
                          defaultValue={
                            data.info.wifi_policy.preferred_check_secs
                          }
                          min={60}
                          max={3600}
                        />
                        <Field
                          label="Reconnect cooldown (seconds)"
                          type="number"
                          name="retry"
                          defaultValue={data.info.wifi_policy.retry_secs}
                          min={5}
                          max={120}
                        />
                        <label className="field-row">
                          <input
                            name="prefer"
                            type="checkbox"
                            defaultChecked={data.info.wifi_policy.prefer_higher}
                          />
                          Prefer higher-priority networks when stable
                        </label>
                        <div className="form-actions">
                          <button disabled={busy}>Save behavior</button>
                        </div>
                      </form>
                    </details>
                  </>
                )}
                {currentSection === "Remote Access" && (
                  <>
                    <SettingRow
                      title="Remote access"
                      detail="Your device initiates the secure connection"
                    >
                      <input
                        type="checkbox"
                        role="switch"
                        aria-label="Enable remote access"
                        checked={data.info.cloud_enabled}
                        onChange={(e) => remoteToggle(e.target.checked)}
                        disabled={busy}
                      />
                    </SettingRow>
                    <SettingRow title="Cloud connection">
                      <span className="secondary">
                        {remoteStatus(
                          data.info.cloud_enabled
                            ? data.network.cloud
                            : "disabled",
                        )}
                      </span>
                    </SettingRow>
                    <SettingRow title="Registered name">
                      <span>
                        {data.network.registered_name || "Not registered yet"}
                      </span>
                    </SettingRow>
                    <SettingRow title="Remote address">
                      <a
                        href={`${data.info.server}/?device=${encodeURIComponent(data.info.name)}`}
                        target="_blank"
                        rel="noreferrer"
                      >
                        {data.info.server.replace(/^https?:\/\//, "")}
                      </a>
                    </SettingRow>
                    <SettingRow title="Last connected">
                      <span className="secondary">
                        {relativeTime(data.network.last_cloud_connection)}
                      </span>
                    </SettingRow>
                    <p className="help-text">
                      Cloudflare reserves the name and relays live commands.
                      Passwords, networks, receivers, and presets stay on your
                      DRouter.
                    </p>
                  </>
                )}
                {currentSection === "Security" && (
                  <>
                    <SettingRow
                      title="Administrator password"
                      detail="Stored and verified only on your DRouter"
                    >
                      <Button onClick={password}>Change</Button>
                    </SettingRow>
                    <SettingRow
                      title="Active sessions"
                      detail="Sessions expire automatically after 24 hours"
                    >
                      <Button
                        onClick={() =>
                          open({
                            title: "Revoke all sessions?",
                            description:
                              "Every local and remote connection will need to authenticate again.",
                            body: null,
                            action: "Revoke sessions",
                            submit: async () => {
                              await call("sessions.revoke");
                              logout(
                                "Sessions revoked. Connect again to continue.",
                              );
                            },
                          })
                        }
                      >
                        Revoke all
                      </Button>
                    </SettingRow>
                    <p className="help-text">
                      Sensitive changes require a connection authenticated
                      within the last five minutes. Identity recovery and
                      factory reset are available from the local interface.
                    </p>
                  </>
                )}
                {currentSection === "System" && (
                  <>
                    <SettingRow title="Firmware">
                      <span className="mono">{data.info.version}</span>
                    </SettingRow>
                    <SettingRow title="Uptime">
                      <span className="mono">
                        {Math.floor(data.health.uptime / 3600)}h{" "}
                        {Math.floor(data.health.uptime / 60) % 60}m
                      </span>
                    </SettingRow>
                    <SettingRow title="Available memory">
                      <span className="mono">
                        {data.health.free_memory
                          ? `${Math.round(data.health.free_memory / 1024)} KiB`
                          : "Host managed"}
                      </span>
                    </SettingRow>
                    <SettingRow title="Configuration storage">
                      <span className="mono">
                        {Math.round(
                          ((data.health.config_bytes || 0) / 1024) * 10,
                        ) / 10}{" "}
                        / 24 KiB
                      </span>
                    </SettingRow>
                    <SettingRow title="Recorded errors">
                      <span className="mono">{data.health.errors}</span>
                    </SettingRow>
                    <p className="help-text">
                      The standalone device keeps routing when Cloud access is
                      unavailable. Use local System settings for recovery or
                      factory reset.
                    </p>
                  </>
                )}
              </section>
            </div>
          </div>
        )}
      </main>
      {dialog && (
        <Modal
          key={dialog.title}
          title={dialog.title}
          description={dialog.description}
          onClose={() => {
            if (!busy) {
              setDialog(null);
              setError("");
            }
          }}
          footer={
            <>
              <Button disabled={busy} onClick={() => setDialog(null)}>
                Cancel
              </Button>
              <button
                type="submit"
                form="action-form"
                className={dialog.destructive ? "danger" : "primary"}
                disabled={busy}
              >
                {busy ? <Spinner /> : null}
                {dialog.action}
              </button>
            </>
          }
        >
          <form
            id="action-form"
            onSubmit={(e) => {
              e.preventDefault();
              const f = Object.fromEntries(new FormData(e.currentTarget));
              void act(() => dialog.submit(f));
            }}
          >
            {dialog.body}
          </form>
        </Modal>
      )}
    </div>
  );
}
function PresetRoutes({ preset, data }: { preset: Preset; data: Snapshot }) {
  return (
    <div>
      {preset.routes.map(([id, source]) => (
        <div className="preset-route" key={id}>
          <span>
            {data.receivers.find((r) => r.config.id === id)?.config.label ||
              "Removed output"}
            <small>
              {data.receivers.find((r) => r.config.id === id)?.state.source ||
                "Unavailable"}
            </small>
          </span>
          <span>{source}</span>
        </div>
      ))}
    </div>
  );
}
createRoot(document.getElementById("root")!).render(<App />);

function SharedControl({
  client,
  page,
}: {
  client: DeviceClient;
  page: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => mountControl(ref.current!, client, page), [client, page]);
  return <div className="page-body" ref={ref} />;
}
function SimpleScreen({
  client,
  logout,
}: {
  client: DeviceClient;
  logout: (message?: string) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => mountSimple(ref.current!, client, logout), [client]);
  return <div ref={ref} />;
}
installLocalization();
