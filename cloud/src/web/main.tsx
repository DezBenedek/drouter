import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import {
  Activity,
  ArrowRight,
  Cable,
  ChevronUp,
  CircleHelp,
  Cloud,
  LayoutDashboard,
  ListVideo,
  LogOut,
  Monitor,
  Network,
  Plus,
  RefreshCw,
  Settings,
  ShieldCheck,
  SlidersHorizontal,
  Trash2,
  Wifi,
} from "lucide-react";
import { Client } from "../../../firmware/web/shared/client.js";
import "../../../firmware/web/shared/style.css";
type Data = Record<string, any>;
const tabs = [
  { name: "Dashboard", icon: LayoutDashboard },
  { name: "Routing", icon: SlidersHorizontal },
  { name: "Devices", icon: Monitor },
  { name: "Presets", icon: ListVideo },
  { name: "Settings", icon: Settings },
];
function Badge({
  online,
  children,
}: {
  online: boolean;
  children: React.ReactNode;
}) {
  return <span className={`badge ${online ? "" : "off"}`}>{children}</span>;
}
function Field({
  name,
  label,
  value = "",
  type = "text",
  required = false,
}: {
  name: string;
  label: string;
  value?: string | number;
  type?: string;
  required?: boolean;
}) {
  return (
    <label>
      {label}
      <input name={name} type={type} defaultValue={value} required={required} />
    </label>
  );
}
function App() {
  const [client, setClient] = useState<Client | null>(null),
    [data, setData] = useState<Data | null>(null),
    [page, setPage] = useState("Dashboard"),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [notice, setNotice] = useState(""),
    [deviceName, setDeviceName] = useState(""),
    [editingWifi, setEditingWifi] = useState<Data | null>(null);
  async function refresh(c = client) {
    if (!c) return;
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
        ].map((op) => c.call(op)),
      );
    setData({
      info,
      health,
      network,
      receivers,
      sources: sources.sources,
      sourceErrors: sources.errors,
      presets,
      wifi,
    });
  }
  function disconnect() {
    client?.close();
    setClient(null);
    setData(null);
  }
  async function run(action: () => Promise<void>) {
    if (busy) return;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await action();
    } catch (e) {
      setError((e as Error).message);
      try {
        await refresh();
      } catch {}
    } finally {
      setBusy(false);
    }
  }
  async function call(op: string, params: Data = {}) {
    const result = await client!.call(op, params);
    await refresh();
    return result;
  }
  const submit =
    (fn: (f: Data) => Promise<void>) =>
    (e: React.FormEvent<HTMLFormElement>) => {
      e.preventDefault();
      const f = Object.fromEntries(new FormData(e.currentTarget));
      void run(() => fn(f));
    };
  if (!client || !data)
    return (
      <div className="login">
        <aside className="login-art">
          <div className="brand">
            <span className="brand-mark">↔</span>DRouter
          </div>
          <div>
            <div className="eyebrow">A direct line to your network</div>
            <h1>
              Your studio.
              <br />
              Within reach.
            </h1>
            <p>
              Connect to your DRouter and control your BirdDog receivers from
              wherever you are.
            </p>
            <div className="route-art">
              {Array.from({ length: 20 }, (_, i) => (
                <span key={i} />
              ))}
            </div>
            <Badge online>
              <ShieldCheck size={13} /> Private device authentication
            </Badge>
          </div>
          <small>Your device holds your data. Cloudflare connects you.</small>
        </aside>
        <main className="login-panel">
          <form
            className="login-form"
            onSubmit={submit(async (f) => {
              const c = new Client();
              c.onDisconnect = () => {
                setClient(null);
                setData(null);
                setError(
                  "Device offline or session closed. Reconnect to continue.",
                );
              };
              try {
                await c.open(f.name, f.password);
                await refresh(c);
                setClient(c);
                setDeviceName(f.name);
              } catch (e) {
                c.close();
                throw e;
              }
            })}
          >
            <div className="eyebrow">Remote workspace</div>
            <h1>Connect to your DRouter.</h1>
            <p>
              Use the remote name shown in your device’s local Settings and your
              administrator password.
            </p>
            {error && (
              <div role="alert" className="notice error">
                {error}
              </div>
            )}
            <Field
              name="name"
              label="DRouter remote name"
              value={deviceName}
              required
            />
            <Field
              name="password"
              label="Device password"
              type="password"
              required
            />
            <button className="primary" disabled={busy}>
              {busy ? "Connecting…" : "Connect"} <ArrowRight size={15} />
            </button>
            <p>
              <small>
                <ShieldCheck size={12} /> Your password is verified on your
                device.
              </small>
            </p>
            <details>
              <summary>
                <CircleHelp size={13} /> Where is my remote name?
              </summary>
              <p>
                <small>
                  Open your DRouter’s local interface, enable Cloud access in
                  Settings, then copy the name with its identity fingerprint. No
                  Cloudflare account is needed.
                </small>
              </p>
            </details>
          </form>
        </main>
      </div>
    );
  const {
    info: i,
    health: h,
    network: n,
    receivers: r,
    sources: s,
    presets: p,
    wifi: w,
  } = data;
  const rename = async (op: string, id: string) => {
    const name = prompt("New name");
    if (name) await call(op, { id, name });
  };
  return (
    <div className="app">
      <aside className="sidebar">
        <div className="brand">
          <span className="brand-mark">↔</span>DRouter
        </div>
        <div className="muted">
          {i.name}
          <br />
          Remote workspace
        </div>
        <nav className="nav">
          {tabs.map((t) => (
            <button
              key={t.name}
              className={page === t.name ? "active" : ""}
              onClick={() => {
                setPage(t.name);
                setNotice("");
                setError("");
              }}
            >
              <t.icon size={17} />
              {t.name}
            </button>
          ))}
        </nav>
        <div className="sidebar-foot">
          <ShieldCheck size={16} /> DEVICE-OWNED DATA
          <br />
          Firmware {i.version}
          <br />
          <button onClick={disconnect}>
            <LogOut size={13} /> Disconnect
          </button>
        </div>
      </aside>
      <main className="main">
        <header className="topbar">
          <span className="muted">
            Workspace <span className="breadcrumb-separator"> / </span>
            {page}
          </span>
          <Badge online>Connected to {i.name}</Badge>
        </header>
        <div className="header-row">
          <div>
            <div className="eyebrow">Your NDI workspace</div>
            <h1>{page}</h1>
            <p>
              {page === "Dashboard"
                ? "A live view of your studio. All data comes from your DRouter."
                : page === "Routing"
                  ? "Every output. Every source. One clear view."
                  : "Manage your device, wherever you are."}
            </p>
          </div>
          <button disabled={busy} onClick={() => void run(() => refresh())}>
            <RefreshCw size={14} /> Refresh
          </button>
        </div>
        {error && (
          <div role="alert" className="notice error">
            {error}
          </div>
        )}
        {notice && <div className="notice">{notice}</div>}
        {busy && (
          <p className="progress">
            Operation pending · waiting for device confirmation…
          </p>
        )}
        {page === "Dashboard" && (
          <>
            <div className="stats">
              {[
                [Monitor, "BirdDog receivers", r.length, "Registered outputs"],
                [Network, "NDI sources", s.length, "Available on receivers"],
                [
                  Activity,
                  "Uptime",
                  `${Math.floor(h.uptime / 60)}m`,
                  "Since last boot",
                ],
                [
                  ShieldCheck,
                  "Device health",
                  h.errors === 0 ? "Healthy" : `${h.errors} errors`,
                  h.free_memory
                    ? `${Math.round(h.free_memory / 1024)} KiB free`
                    : "Host managed memory",
                ],
              ].map(([Icon, title, value, detail]: any) => (
                <div className="card" key={title}>
                  <div className="actions">
                    <Icon size={16} />
                    <small>{title}</small>
                  </div>
                  <div className="stat-value">{value}</div>
                  <small>{detail}</small>
                </div>
              ))}
            </div>
            <div className="grid">
              <section className="card">
                <h2>Network overview</h2>
                <div className="row">
                  <span>
                    <Cable size={16} /> Ethernet
                  </span>
                  <Badge online={n.ethernet.link}>
                    {n.ethernet.ip || "Disconnected"}
                  </Badge>
                </div>
                <div className="row">
                  <span>
                    <Wifi size={16} /> Wi-Fi
                  </span>
                  <Badge online={n.wifi.connected}>
                    {n.active_ssid || "Disconnected"}
                  </Badge>
                </div>
                <div className="row">
                  <span>
                    <Cloud size={16} /> Cloud access
                  </span>
                  <Badge online={n.cloud === "connected"}>{n.cloud}</Badge>
                </div>
              </section>
              <section className="card">
                <div className="header-row">
                  <h2>Outputs at a glance</h2>
                  <button onClick={() => setPage("Routing")}>
                    Open matrix <ArrowRight size={13} />
                  </button>
                </div>
                {r.map((x: Data) => (
                  <div className="row" key={x.config.id}>
                    <div>
                      <b>{x.config.label}</b>
                      <br />
                      <small>{x.state.source || x.state.error}</small>
                    </div>
                    <Badge online={x.state.online}>
                      {x.state.online ? "Online" : "Offline"}
                    </Badge>
                  </div>
                ))}
                {!r.length && (
                  <p>Add your first BirdDog receiver in Devices.</p>
                )}
              </section>
            </div>
          </>
        )}
        {page === "Routing" && (
          <section className="card">
            <div className="header-row">
              <div>
                <h2>Routing matrix</h2>
                <small>
                  Source changes are verified on the actual receiver.
                </small>
              </div>
              <button
                disabled={busy}
                onClick={() =>
                  void run(async () => {
                    await call("sources.refresh");
                  })
                }
              >
                <RefreshCw size={14} /> Scan sources
              </button>
            </div>
            {!r.length ? (
              <div className="empty">
                Add a BirdDog receiver in Devices to start routing.
              </div>
            ) : (
              <div className="table-scroll">
                <table>
                  <thead>
                    <tr>
                      <th>Output / Source</th>
                      {s.map((x: Data) => (
                        <th key={x.name}>{x.name}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {r.map((x: Data) => (
                      <tr key={x.config.id}>
                        <td>
                          <b>{x.config.label}</b>
                          <br />
                          <small>
                            {x.state.error || x.state.source || "No source"}
                          </small>
                        </td>
                        {s.map((y: Data) => (
                          <td key={y.name}>
                            <button
                              className={`matrix ${x.state.source === y.name ? "selected" : ""}`}
                              disabled={busy || !x.state.online}
                              aria-label={`Route ${y.name} to ${x.config.label}`}
                              onClick={() =>
                                void run(async () => {
                                  await call("route.set", {
                                    receiver: x.config.id,
                                    source: y.name,
                                  });
                                })
                              }
                            >
                              {x.state.source === y.name ? "✓" : "+"}
                            </button>
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            <div className="matrix-legend">
              <span className="dot" /> Verified active source{" "}
              <span className="legend-hint">Select a cell to route</span>
            </div>
            {data.sourceErrors.map((e: Data) => (
              <p key={e.receiver} className="notice error">
                {e.receiver}: {e.message}
              </p>
            ))}
          </section>
        )}
        {page === "Devices" && (
          <div className="grid">
            <section className="card">
              <div className="header-row">
                <h2>BirdDog receivers</h2>
                <button
                  disabled={busy}
                  onClick={() =>
                    void run(async () => {
                      const found = await client.call("receivers.discover");
                      for (const receiver of found)
                        await client.call("receivers.add", receiver);
                      await refresh();
                      setNotice(
                        found.length
                          ? `Added ${found.length} verified receivers.`
                          : "No verified receivers found. Add devices by IP.",
                      );
                    })
                  }
                >
                  Detect devices
                </button>
              </div>
              {r.map((x: Data) => (
                <div className="row" key={x.config.id}>
                  <div>
                    <b>{x.config.label}</b>
                    <br />
                    <small>
                      {x.config.ip}:{x.config.port} · API 2.0
                    </small>
                    <br />
                    <Badge online={x.state.online}>
                      {x.state.online ? "Online" : "Offline"}
                    </Badge>
                  </div>
                  <div className="actions">
                    <button
                      disabled={busy}
                      onClick={() =>
                        void run(() => rename("receivers.rename", x.config.id))
                      }
                    >
                      Rename
                    </button>
                    <button
                      disabled={busy}
                      onClick={() =>
                        void run(async () => {
                          await call("receivers.remove", { id: x.config.id });
                        })
                      }
                    >
                      <Trash2 size={14} />
                    </button>
                  </div>
                </div>
              ))}
            </section>
            <form
              className="card"
              onSubmit={submit(async (f) => {
                await call("receivers.add", {
                  id: crypto.randomUUID().slice(0, 8),
                  label: f.label,
                  ip: f.ip,
                  port: +f.port,
                  channel: +f.channel,
                });
              })}
            >
              <h2>Add a receiver</h2>
              <p>
                <small>
                  Register a BirdDog decoder on the device’s local network.
                </small>
              </p>
              <Field name="label" label="Label" required />
              <Field name="ip" label="IPv4 address" required />
              <Field
                name="port"
                label="API port"
                type="number"
                value={8080}
                required
              />
              <Field
                name="channel"
                label="Channel"
                type="number"
                value={1}
                required
              />
              <button className="primary" disabled={busy}>
                <Plus size={14} /> Add receiver
              </button>
            </form>
          </div>
        )}
        {page === "Presets" && (
          <div className="grid">
            <section className="card">
              <h2>Saved presets</h2>
              {p.map((x: Data) => (
                <div className="row" key={x.id}>
                  <div>
                    <b>{x.name}</b>
                    <br />
                    <small>{x.routes.length} outputs</small>
                  </div>
                  <div className="actions">
                    <button
                      className="primary"
                      disabled={busy}
                      onClick={() =>
                        void run(async () => {
                          const result = await call("presets.apply", {
                            id: x.id,
                          });
                          setNotice(
                            result.results
                              .map(
                                (x: Data) =>
                                  `${x.receiver}: ${x.ok ? "Verified" : x.error}`,
                              )
                              .join("\n"),
                          );
                        })
                      }
                    >
                      Apply
                    </button>
                    <button
                      disabled={busy}
                      onClick={() =>
                        void run(() => rename("presets.update", x.id))
                      }
                    >
                      Rename
                    </button>
                    <button
                      disabled={busy}
                      onClick={() =>
                        void run(async () => {
                          await call("presets.delete", { id: x.id });
                        })
                      }
                    >
                      <Trash2 size={14} />
                    </button>
                  </div>
                </div>
              ))}
              {!p.length && (
                <p>No presets yet. Save your first routing setup.</p>
              )}
            </section>
            <form
              className="card"
              onSubmit={submit(async (f) => {
                await call("presets.create", { name: f.name });
              })}
            >
              <h2>Save current routing</h2>
              <p>Capture the actual sources reported by all your receivers.</p>
              <Field name="name" label="Preset name" required />
              <button className="primary" disabled={busy}>
                Save preset
              </button>
            </form>
          </div>
        )}
        {page === "Settings" && (
          <div className="grid">
            <form
              className="card"
              onSubmit={submit(async (f) => {
                await client.call("settings.update", {
                  expected_revision: i.revision,
                  name: f.name,
                  cloud_enabled: !!f.cloud,
                  ...(f.password ? { password: f.password } : {}),
                });
                disconnect();
              })}
            >
              <h2>Device & remote access</h2>
              <Field name="name" label="Device name" value={i.name} />
              <Field
                name="password"
                label="New password (leave empty to keep)"
                type="password"
              />
              <label className="check">
                <input
                  name="cloud"
                  type="checkbox"
                  defaultChecked={i.cloud_enabled}
                />
                Enable Cloud access
              </label>
              <p>
                <small>
                  Remote name
                  <br />
                  {i.remote_name}
                </small>
              </p>
              <p>
                <small>
                  Saving these settings revokes sessions. Reconnect with the
                  updated credentials. The server address can be changed
                  locally.
                </small>
              </p>
              <button className="primary" disabled={busy}>
                Save settings
              </button>
            </form>
            <section className="card">
              <h2>Saved Wi-Fi networks</h2>
              <p>
                <small>
                  Top to bottom priority. Passwords stay on the device.
                </small>
              </p>
              {w.map((x: Data, index: number) => (
                <div className="row" key={x.id}>
                  <b>
                    <small>{index + 1}.</small> {x.ssid}
                  </b>
                  <div className="actions">
                    <button
                      disabled={busy || index === 0}
                      onClick={() =>
                        void run(async () => {
                          const ids = w.map((x: Data) => x.id);
                          [ids[index - 1], ids[index]] = [
                            ids[index],
                            ids[index - 1],
                          ];
                          await call("wifi.reorder", { ids });
                        })
                      }
                    >
                      <ChevronUp size={13} />
                    </button>
                    <button
                      disabled={busy}
                      onClick={() =>
                        void run(async () => {
                          await call("wifi.connect", { id: x.id });
                        })
                      }
                    >
                      Connect
                    </button>
                    <button disabled={busy} onClick={() => setEditingWifi(x)}>
                      Edit
                    </button>
                    <button
                      disabled={busy}
                      onClick={() =>
                        void run(async () => {
                          await call("wifi.remove", { id: x.id });
                        })
                      }
                    >
                      <Trash2 size={13} />
                    </button>
                  </div>
                </div>
              ))}
              <form
                key={editingWifi?.id || "new-wifi"}
                onSubmit={submit(async (f) => {
                  await call("wifi.add", {
                    id: editingWifi?.id || crypto.randomUUID().slice(0, 8),
                    ssid: f.ssid,
                    password: f.password,
                  });
                  setEditingWifi(null);
                })}
              >
                <Field
                  name="ssid"
                  label="SSID"
                  value={editingWifi?.ssid || ""}
                  required
                />
                <Field
                  name="password"
                  label="Wi-Fi password"
                  type="password"
                  required
                />
                <button disabled={busy}>
                  {editingWifi ? "Save network" : "Add network"}
                </button>
                {editingWifi && (
                  <button type="button" onClick={() => setEditingWifi(null)}>
                    Cancel
                  </button>
                )}
              </form>
            </section>
            <form
              className="card"
              onSubmit={submit(async (f) => {
                await call("settings.update", {
                  expected_revision: i.revision,
                  ethernet: Object.fromEntries(
                    ["address", "mask", "gateway", "dns"].map((k) => [
                      k,
                      f[k] || null,
                    ]),
                  ),
                });
                setNotice("Ethernet settings saved on the device.");
              })}
            >
              <h2>Ethernet</h2>
              <p>
                <small>Leave the address empty for DHCP.</small>
              </p>
              {["address", "mask", "gateway", "dns"].map((k) => (
                <Field
                  key={k}
                  name={k}
                  label={
                    {
                      address: "IPv4 address",
                      mask: "Subnet mask",
                      gateway: "Gateway",
                      dns: "DNS",
                    }[k]!
                  }
                  value={i.ethernet_config[k] || ""}
                />
              ))}
              <button disabled={busy}>Save Ethernet</button>
            </form>
            <section className="card">
              <form
                onSubmit={submit(async (f) => {
                  await call("settings.update", {
                    expected_revision: i.revision,
                    wifi_policy: {
                      preferred_check_secs: +f.preferred,
                      retry_secs: +f.retry,
                      prefer_higher: !!f.prefer,
                    },
                  });
                })}
              >
                <h2>Wi-Fi priority policy</h2>
                <Field
                  name="preferred"
                  label="Preferred scan interval (60–3600 seconds)"
                  type="number"
                  value={i.wifi_policy.preferred_check_secs}
                />
                <Field
                  name="retry"
                  label="Retry interval (5–120 seconds)"
                  type="number"
                  value={i.wifi_policy.retry_secs}
                />
                <label className="check">
                  <input
                    name="prefer"
                    type="checkbox"
                    defaultChecked={i.wifi_policy.prefer_higher}
                  />
                  Prefer higher priority networks
                </label>
                <button disabled={busy}>Save policy</button>
              </form>
              <div className="section-label">Security</div>
              <p>
                <small>
                  Sensitive operations require a connection authenticated within
                  the last 5 minutes.
                </small>
              </p>
              <button
                disabled={busy}
                onClick={() =>
                  void run(async () => {
                    await client.call("sessions.revoke");
                    disconnect();
                  })
                }
              >
                Revoke all sessions
              </button>
            </section>
          </div>
        )}
      </main>
    </div>
  );
}
createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
