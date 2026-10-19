import { DurableObject } from "cloudflare:workers";
import type { Env } from "./index";
import { remoteName, identityId } from "./auth";
import { ReservationError, reservationFailure } from "./reservation";
export type DeviceRecord = {
  device_id: string;
  name: string;
  public_key: string;
  registered_at: number;
  renamed_at: number;
  last_connected: number;
};
export class DeviceRegistry extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS devices (device_id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, public_key TEXT NOT NULL, registered_at INTEGER NOT NULL, renamed_at INTEGER NOT NULL, last_connected INTEGER NOT NULL)",
    );
    ctx.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS names (name TEXT PRIMARY KEY, device_id TEXT NOT NULL REFERENCES devices(device_id), reserved_at INTEGER NOT NULL)",
    );
  }
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/lookup") {
      const name = url.searchParams.get("name") || "";
      if (!remoteName.test(name)) return Response.json(null);
      const record = this.ctx.storage.sql
        .exec<DeviceRecord>(
          "SELECT d.* FROM names n JOIN devices d ON d.device_id=n.device_id WHERE n.name=?",
          name,
        )
        .toArray()[0];
      return Response.json(record || null);
    }
    if (request.method !== "POST" || url.pathname !== "/reserve")
      return new Response(null, { status: 404 });
    const value = (await request.json()) as {
      name: string;
      deviceId: string;
      publicKey: string;
    };
    if (
      !remoteName.test(value.name) ||
      !/^[a-f0-9]{64}$/.test(value.publicKey) ||
      value.deviceId !== (await identityId(value.publicKey))
    )
      return Response.json({ error: "invalid_identity" }, { status: 400 });
    try {
      const record = this.ctx.storage.transactionSync(() => {
        const sql = this.ctx.storage.sql;
        const reserved = sql
          .exec<{ device_id: string }>(
            "SELECT device_id FROM names WHERE name=?",
            value.name,
          )
          .toArray()[0];
        if (reserved && reserved.device_id !== value.deviceId)
          throw new ReservationError("name_unavailable");
        const existing = sql
          .exec<DeviceRecord>(
            "SELECT * FROM devices WHERE device_id=?",
            value.deviceId,
          )
          .toArray()[0];
        if (existing && existing.public_key !== value.publicKey)
          throw new ReservationError("invalid_identity");
        const now = Date.now();
        if (!existing)
          sql.exec(
            "INSERT INTO devices VALUES(?,?,?,?,?,?)",
            value.deviceId,
            value.name,
            value.publicKey,
            now,
            now,
            now,
          );
        else if (existing.name !== value.name)
          sql.exec(
            "UPDATE devices SET name=?, renamed_at=?, last_connected=? WHERE device_id=?",
            value.name,
            now,
            now,
            value.deviceId,
          );
        else
          sql.exec(
            "UPDATE devices SET last_connected=? WHERE device_id=? AND last_connected<?",
            now,
            value.deviceId,
            now - 3600000,
          );
        sql.exec(
          "INSERT OR IGNORE INTO names VALUES(?,?,?)",
          value.name,
          value.deviceId,
          now,
        );
        return sql
          .exec<DeviceRecord>(
            "SELECT * FROM devices WHERE device_id=?",
            value.deviceId,
          )
          .one();
      });
      return Response.json(record);
    } catch (error) {
      return reservationFailure(error);
    }
  }
}
export function registry(env: Env): DurableObjectStub {
  return env.REGISTRY.get(env.REGISTRY.idFromName("device-names-v1"));
}
