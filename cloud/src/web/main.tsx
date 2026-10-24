import {
  mountControl,
  mountSimple,
  toggleEvent,
  toast,
  dismissToast,
} from "../../../firmware/web/shared/control.js";
import { installLocalization } from "../../../firmware/web/shared/i18n.js";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { Feedback } from "./feedback";
import {
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
  { name: "Devices", icon: Monitor },
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
            variant="quiet icon-button appearance-toggle"
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
    [busy, setBusy] = useState(false),
    [message, setMessage] = useState(""),
    [error, setError] = useState(""),
    [dialog, setDialog] = useState<DialogSpec | null>(null),
    [outputSearch, setOutputSearch] = useState("");
  useFeedback(error, "error");
  useFeedback(message, "success");
  const previousPage = useRef(page);
  useEffect(() => {
    if (previousPage.current !== page) {
      window.scrollTo({ top: 0, behavior: "instant" });
      previousPage.current = page;
    }
  }, [page]);
  useEffect(() => {
    if (!more) return;
    const close = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setMore(false);
        document.querySelector<HTMLButtonElement>(".mobile-more")?.focus();
      }
    };
    const resize = () => {
      if (innerWidth >= 900) setMore(false);
    };
    document.addEventListener("keydown", close);
    window.addEventListener("resize", resize);
    document.querySelector<HTMLButtonElement>(".more-menu button")?.focus();
    return () => {
      document.removeEventListener("keydown", close);
      window.removeEventListener("resize", resize);
    };
  }, [more]);
  const working = useRef(false);
  const ended = useRef(false);
  function logout(message = "", kind = "success") {
    ended.current = true;
    client.onDisconnect = () => {};
    leave(message, kind);
  }
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
        page !== "Routing" &&
        page !== "Sources" &&
        page !== "Settings" &&
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
  }, [page]);
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
  function renameReceiver(id: string, name: string) {
    open({
      title: "Rename output",
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
        await call("receivers.rename", { id, name: f.name });
      },
    });
  }
  function removeReceiver(id: string, name: string) {
    open({
      title: `Remove ${name}?`,
      description:
        "The receiver will stop appearing in this workspace.",
      body: null,
      action: "Remove",
      destructive: true,
      submit: async () => {
        await call("receivers.remove", { id });
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
  function wifiChange(op: string, params: any) {
    void act(async () => {
      await call(op, { ...params, confirm_disconnect: true });
    });
  }
  function wifiRemove(profile: Profile) {
    open({
      title: `Remove ${profile.ssid}?`,
      description:
        "This removes the saved network and its password. If the connection is lost, use Ethernet or the physical recovery process.",
      body: null,
      action: "Remove network",
      destructive: true,
      submit: async () => {
        await call("wifi.remove", {
          id: profile.id,
          confirm_disconnect: true,
        });
      },
    });
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
          {profile && (
            <p className="help-text">
              Leave the password empty to keep the saved one.
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
    void act(async () => {
      const result = await call("settings.update", {
        expected_revision: data.info.revision,
        cloud_enabled: enabled,
      });
      if (result?.reauthenticate)
        logout("Remote access updated. Reconnect to continue.");
      else setMessage(enabled ? "Remote access enabled." : "Remote access disabled.");
    });
  }
  const filteredReceivers = data.receivers.filter((r) =>
    `${r.config.label} ${r.config.ip}`
      .toLowerCase()
      .includes(outputSearch.toLowerCase()),
  );
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
              onClick={() => renameReceiver(r.config.id, r.config.label)}
            >
              Rename
            </Button>
            <Button
              variant="danger"
              onClick={() =>
                removeReceiver(r.config.id, r.config.label)
              }
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
            variant="quiet icon-button appearance-toggle"
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
          aria-controls="more-menu"
          aria-expanded={more}
          aria-current={page === "Devices" ? "page" : undefined}
          onClick={() => setMore(!more)}
        >
          <MoreHorizontal />
          <span>More</span>
        </Button>
        <div className="nav-footer">DRouter {data.info.version}</div>
      </nav>
      {more && (
        <>
          <div
            className="more-backdrop"
            onClick={() => setMore(false)}
            aria-hidden="true"
          />
          <div
            className="more-menu"
            role="region"
            aria-label="More"
            id="more-menu"
          >
            <div className="more-preferences">
              <span data-language-host />
              <Button variant="quiet" onClick={changeTheme}>
                Change appearance
              </Button>
            </div>
          </div>
        </>
      )}
      <main id="main" className="app-main">
        <header className="page-header">
          <div className="page-heading">
            <h1>{page}</h1>
          </div>
          <div className="page-actions">
            {page === "Devices" && (
              <Button variant="primary" disabled={busy} onClick={addReceiver}>
                <Plus />
                Add receiver
              </Button>
            )}
          </div>
        </header>
        {page === "Routing" && <SharedControl client={client} page="Routing" />}
        {page === "Sources" && (
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
                        renameReceiver(r.config.id, r.config.label)
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
                        removeReceiver(r.config.id, r.config.label)
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
        {page === "Settings" && (
          <div className="page-body settings-single">
            <section className="settings-card" aria-label="Device">
              <h2>Device</h2>
              <SettingRow title="Device name" detail="Also used for remote login">
                <span className="inline-actions">
                  <span>{data.info.name}</span>
                  <Button onClick={general}>Change</Button>
                </span>
              </SettingRow>
              <SettingRow title="Appearance">
                <select aria-label="Appearance" value={appearance} onChange={() => changeTheme()}>
                  <option value="light">Light</option>
                  <option value="dark">Dark</option>
                </select>
              </SettingRow>
              <SettingRow title="Device identity" detail="Stays the same across renames">
                <span className="mono secondary">{data.info.device_id?.slice(0, 16)}…</span>
              </SettingRow>
            </section>
            <section className="settings-card" aria-label="Network">
              <h2>Network</h2>
              <SettingRow title="Connection">
                <Status online={data.network.ethernet.link}>
                  {data.network.ethernet.ip || "Disconnected"}
                </Status>
              </SettingRow>
              <form
                className="settings-group"
                onSubmit={(e) => {
                  e.preventDefault();
                  const f = Object.fromEntries(new FormData(e.currentTarget));
                  void act(async () => {
                    await call("settings.update", {
                      expected_revision: data.info.revision,
                      ethernet: Object.fromEntries(
                        ["address", "mask", "gateway", "dns"].map((k) => [k, f[k] || null]),
                      ),
                    });
                    setMessage("Ethernet settings saved.");
                  }, false);
                }}
              >
                <div className="form-grid form-spaced">
                  <Field label="IPv4 address" name="address" defaultValue={data.info.ethernet_config.address || ""} placeholder="Automatic (DHCP)" inputMode="decimal" hint="Leave empty to use DHCP." />
                  <Field label="Subnet mask" name="mask" defaultValue={data.info.ethernet_config.mask || ""} placeholder="255.255.255.0" inputMode="decimal" />
                  <Field label="Gateway" name="gateway" defaultValue={data.info.ethernet_config.gateway || ""} inputMode="decimal" />
                  <Field label="DNS server" name="dns" defaultValue={data.info.ethernet_config.dns || ""} inputMode="decimal" />
                </div>
                <div className="form-actions">
                  <button className="primary" disabled={busy}>Save Ethernet</button>
                </div>
              </form>
              <h3>Wi-Fi</h3>
              <div className="inline-actions">
                <Button onClick={() => editWifi()} disabled={busy}>
                  <Plus />
                  Add network
                </Button>
              </div>
              <div className="data-list list-spaced">
                {data.wifi.map((w, index) => (
                  <div className={`wifi-row ${w.enabled ? "" : "disabled"}`} key={w.id}>
                    <span className="priority">{index + 1}</span>
                    <div className="wifi-copy">
                      <strong data-user-content>{w.ssid}</strong>
                      <span className="secondary">
                        {data.network.wifi.active === w.id && data.network.wifi.connected
                          ? "Connected"
                          : w.enabled ? "Saved" : "Disabled"}
                      </span>
                    </div>
                    <div className="wifi-actions">
                      <Button variant="quiet icon-button" aria-label={`Move ${w.ssid} up`} disabled={busy || index === 0} onClick={() => moveWifi(w.id, -1)}>↑</Button>
                      <Button variant="quiet icon-button" aria-label={`Move ${w.ssid} down`} disabled={busy || index === data.wifi.length - 1} onClick={() => moveWifi(w.id, 1)}>↓</Button>
                      <Button variant="quiet" className="edit-network" onClick={() => editWifi(w)}>Edit</Button>
                      <input type="checkbox" role="switch" aria-label={`Enable ${w.ssid}`} checked={w.enabled} disabled={busy} onChange={(e) => wifiChange("wifi.set_enabled", { id: w.id, enabled: e.target.checked })} />
                      <Button variant="quiet" disabled={busy || !w.enabled} onClick={() => wifiChange("wifi.connect", { id: w.id })}>Reconnect</Button>
                      <Button variant="quiet danger" disabled={busy} onClick={() => wifiRemove(w)}>Remove</Button>
                    </div>
                  </div>
                ))}
              </div>
              <p className="help-text">Passwords stay on this device. Use the arrows to change priority.</p>
            </section>
            <section className="settings-card" aria-label="Remote access">
              <h2>Remote access</h2>
              <SettingRow title="Remote access" detail="Your device initiates the secure connection">
                <input type="checkbox" role="switch" aria-label="Enable remote access" checked={data.info.cloud_enabled} onChange={(e) => remoteToggle(e.target.checked)} disabled={busy} />
              </SettingRow>
              <SettingRow title="Cloud connection">
                <span className="secondary">{remoteStatus(data.info.cloud_enabled ? data.network.cloud : "disabled")}</span>
              </SettingRow>
              <SettingRow title="Registered name">
                <span>{data.network.registered_name || "Not registered yet"}</span>
              </SettingRow>
              <SettingRow title="Remote address">
                <a href={`${data.info.server}/?device=${encodeURIComponent(data.info.name)}`} target="_blank" rel="noreferrer">
                  {data.info.server.replace(/^https?:\/\//, "")}
                </a>
              </SettingRow>
              <SettingRow title="Last connected">
                <span className="secondary">{relativeTime(data.network.last_cloud_connection)}</span>
              </SettingRow>
            </section>
            <section className="settings-card" aria-label="Access">
              <h2>Access</h2>
              <SharedControl client={client} page="Access Control" />
            </section>
            <section className="settings-card" aria-label="Security">
              <h2>Security</h2>
              <SettingRow title="Administrator password" detail="Stored and verified only on your DRouter">
                <Button onClick={password}>Change</Button>
              </SettingRow>
              <SettingRow title="Active sessions" detail="Sessions expire automatically after 24 hours">
                <Button onClick={() => open({
                  title: "Revoke all sessions?",
                  description: "Every local and remote connection will need to authenticate again.",
                  body: null,
                  action: "Revoke sessions",
                  submit: async () => {
                    await call("sessions.revoke");
                    logout("Sessions revoked. Connect again to continue.");
                  },
                })}>Revoke all</Button>
              </SettingRow>
            </section>
            <section className="settings-card" aria-label="System">
              <h2>System</h2>
              <SettingRow title="Firmware"><span className="mono">{data.info.version}</span></SettingRow>
              <SettingRow title="Uptime"><span className="mono">{Math.floor(data.health.uptime / 3600)}h {Math.floor(data.health.uptime / 60) % 60}m</span></SettingRow>
              <SettingRow title="Available memory"><span className="mono">{data.health.free_memory ? `${Math.round(data.health.free_memory / 1024)} KiB` : "Host managed"}</span></SettingRow>
              <SettingRow title="Recorded errors"><span className="mono">{data.health.errors}</span></SettingRow>
            </section>
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
createRoot(document.getElementById("root")!).render(
  <>
    <App />
    <Feedback />
  </>,
);

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
