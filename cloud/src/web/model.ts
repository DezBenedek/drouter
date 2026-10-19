import { language } from "../../../firmware/web/shared/i18n.js";
export type Receiver = {
  config: {
    id: string;
    label: string;
    ip: string;
    port: number;
    channel: number;
  };
  state: {
    receiver: string;
    source: string | null;
    online: boolean;
    error: string | null;
  };
  capabilities: string[];
  model?: string;
};
export type Source = { name: string };
export type Profile = {
  id: string;
  ssid: string;
  enabled: boolean;
  priority: number;
};
export type Preset = { id: string; name: string; routes: [string, string][] };
export type Snapshot = {
  info: any;
  health: any;
  network: any;
  receivers: Receiver[];
  sources: Source[];
  sourceErrors: { receiver: string; message: string }[];
  presets: Preset[];
  wifi: Profile[];
};
export type DeviceClient = {
  call: (op: string, params?: any) => Promise<any>;
  close: () => void;
  onDisconnect: () => void;
};
export async function snapshot(client: DeviceClient): Promise<Snapshot> {
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
  return {
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
export function relativeTime(seconds?: number) {
  if (!seconds) return "Not connected yet";
  const minutes = Math.max(0, Math.floor((Date.now() / 1000 - seconds) / 60));
  return minutes < 1
    ? "Just now"
    : minutes < 60
      ? `${minutes} minutes ago`
      : new Date(seconds * 1000).toLocaleString(language());
}
