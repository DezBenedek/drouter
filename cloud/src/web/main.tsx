import {
  mountControl,
  installActivity,
  installSettingsSidebar,
  beginTask,
  mountSimple,
  toggleEvent,
  toast,
  dismissToast,
} from "../../../firmware/web/shared/control.js";
import { installLocalization } from "../../../firmware/web/shared/i18n.js";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { Feedback } from "./feedback";
import { LogOut, Plus, Settings as SettingsIcon } from "lucide-react";
import { Client, remoteStatus } from "../../../firmware/web/shared/client.js";
import "../../../firmware/web/shared/theme.js";
import "../../../firmware/web/shared/style.css";
import {
  Brand,
  Button,
  Field,
  Modal,
  Password,
  SettingRow,
  Spinner,
  Status,
} from "./primitives";
import {
  relativeTime,
  snapshot,
  type DeviceClient,
  type Profile,
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
    [busy, setBusy] = useState(false);
  const [restricted, setRestricted] = useState<DeviceClient | null>(null);
  const [restoring, setRestoring] = useState(true);
  const [feedbackKind, setFeedbackKind] = useState("error");
  useFeedback(error, feedbackKind);
  const initialName = new URLSearchParams(location.search).get("device") || "";
  useEffect(() => {
    let disposed = false;
    void (async () => {
      const client = await Client.restore({ name: initialName });
      if (disposed) {
        client?.close();
        return;
      }
      try {
        if (client) {
          const role = await client.call("auth.session");
          if (role.role === "simple_mode") setRestricted(client);
          else {
            const data = await snapshot(client);
            if (!disposed) setSession({ client, data });
          }
        }
      } catch {
        client?.close();
      } finally {
        if (!disposed) setRestoring(false);
      }
    })();
    return () => {
      disposed = true;
    };
  }, []);
  function disconnect(message = "", kind = "error") {
    dismissToast();
    if (session) {
      session.client.onDisconnect = () => {};
      session.client.close();
    }
    if (restoring)
      return (
        <main className="auth-screen">
          <p className="loading-state" role="status">
            <Spinner />
            Restoring session…
          </p>
        </main>
      );
    if (restricted) {
      restricted.onDisconnect = () => {};
      restricted.close();
    }
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
      </div>
    </main>
  );
}
function Workspace({
  initial,
  client,
  logout: leave,
}: {
  initial: Snapshot;
  client: DeviceClient;
  logout: (message?: string, kind?: string) => void;
}) {
  const [data, setData] = useState(initial),
    [page, setPage] = useState("Routing"),
    [eventBusy, setEventBusy] = useState(false),
    [busy, setBusy] = useState(false),
    [message, setMessage] = useState(""),
    [error, setError] = useState(""),
    [dialog, setDialog] = useState<DialogSpec | null>(null);
  useFeedback(error, "error");
  useFeedback(message, "success");
  const previousPage = useRef(page);
  useEffect(() => {
    if (previousPage.current !== page) {
      window.scrollTo({ top: 0, behavior: "instant" });
      previousPage.current = page;
    }
  }, [page]);
  const working = useRef(false);
  const ended = useRef(false);
  function logout(message = "", kind = "success") {
    ended.current = true;
    client.onDisconnect = () => {};
    leave(message, kind);
  }
  async function refresh() {
    const [info, health, network, wifi] = await Promise.all(
      ["device.info", "device.health", "network.status", "wifi.list"].map(
        (op) => client.call(op),
      ),
    );
    const next = { ...data, info, health, network, wifi };
    setData(next);
    return next;
  }
  useEffect(() => {
    client.onDisconnect = () =>
      logout("Device disconnected. Reconnect to view live routing.", "error");
    return () => {
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
    const activity = beginTask("Settings");
    try {
      await task();
      activity.done();
      if (ended.current) return;
      await refresh();
      if (close) setDialog(null);
    } catch (e) {
      activity.fail((e as Error).message);
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
      else
        setMessage(
          enabled ? "Remote access enabled." : "Remote access disabled.",
        );
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
          <span data-language-host />
          <Button
            aria-label="Settings"
            className="settings-trigger"
            aria-expanded={page === "Settings"}
            onClick={() => {
              setPage("Settings");
              void refresh().catch((e) => setError(e.message));
            }}
          >
            <SettingsIcon />
            <span>Settings</span>
          </Button>
        </div>
      </header>
      <main id="main" className="app-main">
        <header className="page-header">
          <div className="page-heading">
            <h1>Routing</h1>
          </div>
        </header>
        <SharedControl client={client} page="Routing" />
        {page === "Settings" && (
          <Modal
            title="Settings"
            onClose={() => setPage("Routing")}
            onMount={(dialog) => installSettingsSidebar(dialog, client)}
          >
            <div className="settings-single">
              <section className="settings-card">
                <SharedControl client={client} page="Access Control" />
              </section>
              <section className="settings-card" aria-label="Device">
                <h2>Device</h2>
                <SettingRow
                  title="Device name"
                  detail="Also used for remote login"
                >
                  <span className="inline-actions">
                    <span>{data.info.name}</span>
                    <Button onClick={general}>Change</Button>
                  </span>
                </SettingRow>
              </section>
              <details className="settings-card">
                <summary>Network</summary>
                <SettingRow title="Ethernet">
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
                <h3>Wi-Fi</h3>
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
                    >
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
                          ↑
                        </Button>
                        <Button
                          variant="quiet icon-button"
                          aria-label={`Move ${w.ssid} down`}
                          disabled={busy || index === data.wifi.length - 1}
                          onClick={() => moveWifi(w.id, 1)}
                        >
                          ↓
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
                            wifiChange("wifi.set_enabled", {
                              id: w.id,
                              enabled: e.target.checked,
                            })
                          }
                        />
                        <Button
                          variant="quiet"
                          disabled={busy || !w.enabled}
                          onClick={() =>
                            wifiChange("wifi.connect", { id: w.id })
                          }
                        >
                          Reconnect
                        </Button>
                        <Button
                          variant="quiet danger"
                          disabled={busy}
                          onClick={() => wifiRemove(w)}
                        >
                          Remove
                        </Button>
                      </div>
                    </div>
                  ))}
                </div>
                <p className="help-text">
                  Passwords stay on this device. Use the arrows to change
                  priority.
                </p>
              </details>
              <details className="settings-card">
                <summary>Remote access</summary>
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
                      data.info.cloud_enabled ? data.network.cloud : "disabled",
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
                <SettingRow
                  title="Custom server"
                  detail="Server changes require local access"
                >
                  <span className="secondary">{data.info.server}</span>
                </SettingRow>
                <SettingRow title="Last connected">
                  <span className="secondary">
                    {relativeTime(data.network.last_cloud_connection)}
                  </span>
                </SettingRow>
              </details>
              <details className="settings-card">
                <summary>Security</summary>
                <SettingRow
                  title="Administrator password"
                  detail="Verified only on this device"
                >
                  <Button onClick={password}>Change</Button>
                </SettingRow>
                <SettingRow
                  title="Active sessions"
                  detail="Sessions last 24 hours; settings access lasts 6 hours"
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
                <SettingRow
                  title="Identity recovery"
                  detail="Keep the file private. Requires local access."
                >
                  <Button disabled title="Requires local access">
                    Export recovery file
                  </Button>
                </SettingRow>
                <SettingRow
                  title="Restore an identity"
                  detail="Requires your recovery file and a new password. Requires local access."
                >
                  <Button disabled title="Requires local access">
                    Restore…
                  </Button>
                </SettingRow>
              </details>
              <details className="settings-card">
                <summary>System</summary>
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
                <SettingRow title="Recorded errors">
                  <span className="mono">{data.health.errors}</span>
                </SettingRow>
                <SettingRow
                  title="Factory reset"
                  detail="Export recovery first. Reserved names stay protected. Requires local access."
                >
                  <Button disabled title="Requires local access">
                    Erase device…
                  </Button>
                </SettingRow>
              </details>
              <Button
                className="settings-logout-action"
                variant="quiet"
                onClick={() => logout()}
              >
                <LogOut />
                Disconnect
              </Button>
            </div>
          </Modal>
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
installActivity();
