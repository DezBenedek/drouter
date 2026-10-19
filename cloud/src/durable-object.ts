import { DurableObject } from "cloudflare:workers";
import type { Env } from "./index";
import { registry, type DeviceRecord } from "./registry";
import { verifyRegistration } from "./auth";
import { parseFrame, validClientFrame } from "./relay";
type Attachment = {
  role: "candidate" | "device" | "browser";
  name: string;
  deviceId: string;
  sid: string;
  nonce: string;
  expires: number;
  stage: string;
  count: number;
  window: number;
  pending: number;
  ip: string;
};
export class RouterRelay extends DurableObject<Env> {
  private sockets(): WebSocket[] {
    return this.ctx.getWebSockets();
  }
  private attachment(ws: WebSocket): Attachment {
    return ws.deserializeAttachment() as Attachment;
  }
  private device(): WebSocket | undefined {
    return this.sockets().find((ws) => this.attachment(ws).role === "device");
  }
  private send(ws: WebSocket, frame: unknown): void {
    ws.send(JSON.stringify(frame));
  }
  async fetch(request: Request): Promise<Response> {
    if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket")
      return new Response("Upgrade required", { status: 426 });
    const url = new URL(request.url);
    const parts = url.pathname.split("/");
    const name = parts[2],
      role = parts[3];
    if (!["device", "browser"].includes(role))
      return new Response("Unavailable", { status: 404 });
    const ip = request.headers.get("CF-Connecting-IP") || "local";
    const sockets = this.sockets();
    if (
      sockets.length >= 12 ||
      sockets.filter(
        (ws) =>
          this.attachment(ws).ip === ip &&
          this.attachment(ws).role !== "device",
      ).length >= 8
    )
      return new Response("Unavailable", { status: 429 });
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    const now = Date.now();
    const a: Attachment = {
      role: role === "device" ? "candidate" : "browser",
      name: request.headers.get("X-DRouter-Name") || name,
      deviceId: name,
      sid: crypto.randomUUID(),
      nonce: crypto.randomUUID(),
      expires: now + 30000,
      stage: "new",
      count: 0,
      window: now,
      pending: 0,
      ip,
    };
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment(a);
    this.send(
      server,
      role === "device"
        ? { type: "challenge", nonce: a.nonce }
        : { type: "hello", sid: a.sid },
    );
    await this.ctx.storage.setAlarm(now + 15000);
    return new Response(null, { status: 101, webSocket: client });
  }
  async webSocketMessage(
    ws: WebSocket,
    message: string | ArrayBuffer,
  ): Promise<void> {
    try {
      const a = this.attachment(ws),
        now = Date.now();
      if (now >= a.expires) throw new Error("Expired");
      if (now - a.window >= 60000) {
        a.count = 0;
        a.window = now;
      }
      if (++a.count > (a.role === "device" ? 600 : 120))
        throw new Error("Rate limit");
      ws.serializeAttachment(a);
      const frame = parseFrame(message);
      if (a.role === "candidate") {
        if (a.stage !== "new" || frame.type !== "register")
          throw new Error("Unavailable");
        a.stage = "verifying";
        ws.serializeAttachment(a);
        if (
          !(await verifyRegistration(a.deviceId, a.nonce, frame)) ||
          this.device()
        )
          throw new Error("Unavailable");
        const reservation = await registry(this.env).fetch(
          "https://registry.internal/reserve",
          {
            method: "POST",
            body: JSON.stringify({
              deviceId: a.deviceId,
              name: frame.name,
              publicKey: frame.publicKey,
            }),
          },
        );
        if (!reservation.ok) {
          this.send(ws, {
            type: "registration.error",
            code: "name_unavailable",
          });
          ws.close(1008, "Name unavailable");
          return;
        }
        if (this.device()) throw new Error("Unavailable");
        const record = (await reservation.json()) as DeviceRecord;
        a.name = record.name;
        a.role = "device";
        a.expires = now + 24 * 3600000;
        a.nonce = "";
        ws.serializeAttachment(a);
        this.send(ws, {
          type: "registered",
          name: record.name,
          deviceId: record.device_id,
          registeredAt: record.registered_at,
        });
        this.ctx.setWebSocketAutoResponse(
          new WebSocketRequestResponsePair(
            '{"type":"ping"}',
            '{"type":"pong"}',
          ),
        );
        return;
      }
      if (a.role === "browser") {
        if (a.pending || !validClientFrame(frame, a.stage))
          throw new Error("Invalid request");
        const device = this.device();
        if (!device || a.stage === "fake") {
          if (a.stage === "new") {
            a.stage = "fake";
            ws.serializeAttachment(a);
            const randomHex = (n: number) =>
              Array.from(crypto.getRandomValues(new Uint8Array(n)), (x) =>
                x.toString(16).padStart(2, "0"),
              ).join("");
            const digest = await crypto.subtle.digest(
              "SHA-256",
              new TextEncoder().encode(
                `drouter-srp-salt-v1:${a.deviceId.slice(0, 32)}`,
              ),
            );
            const salt = Array.from(new Uint8Array(digest), (x) =>
              x.toString(16).padStart(2, "0"),
            ).join("");
            this.send(ws, { type: "auth.challenge", salt, b: randomHex(256) });
            return;
          }
          throw new Error("Unavailable");
        }
        a.pending = now + 15000;
        ws.serializeAttachment(a);
        this.send(device, { type: "forward", sid: a.sid, frame });
        await this.ctx.storage.setAlarm(Math.min(a.pending, now + 15000));
        return;
      }
      if (frame.type === "reply" && typeof frame.sid === "string") {
        const browser = this.sockets().find((other) => {
          const b = this.attachment(other);
          return b.role === "browser" && b.sid === frame.sid;
        });
        if (!browser) return;
        const b = this.attachment(browser);
        if (!b.pending || now > b.pending) {
          browser.close(1008, "Unavailable");
          return;
        }
        const reply = frame.frame as Record<string, unknown>;
        if (!reply || typeof reply.type !== "string")
          throw new Error("Invalid reply");
        if (reply.type === "auth.challenge" && b.stage === "new")
          b.stage = "challenge";
        else if (reply.type === "auth.ok" && b.stage === "challenge") {
          b.stage = "authorized";
          b.expires = now + 1800000;
        } else if (reply.type !== "rpc" || b.stage !== "authorized") {
          this.send(browser, {
            type: "error",
            message: "Request rejected or device unavailable",
          });
          browser.close(1008, "Unavailable");
          return;
        }
        b.pending = 0;
        browser.serializeAttachment(b);
        this.send(browser, reply);
      }
    } catch {
      this.send(ws, {
        type: "error",
        message: "Request rejected or device unavailable",
      });
      ws.close(1008, "Unavailable");
    }
  }
  async webSocketClose(
    ws: WebSocket,
    code: number,
    reason: string,
    wasClean: boolean,
  ): Promise<void> {
    const a = this.attachment(ws);
    if (a.role === "device")
      for (const other of this.sockets()) {
        if (other !== ws && this.attachment(other).role === "browser") {
          this.send(other, { type: "offline" });
          other.close(1012, "Device unavailable");
        }
      }
    if (a.role === "browser") {
      const device = this.device();
      if (device) this.send(device, { type: "leave", sid: a.sid });
    }
    ws.close(
      [
        1000, 1001, 1002, 1003, 1007, 1008, 1009, 1010, 1011, 1012, 1013, 1014,
      ].includes(code)
        ? code
        : 1000,
      "Connection closed",
    );
  }
  async webSocketError(ws: WebSocket): Promise<void> {
    await this.webSocketClose(ws, 1011, "Unavailable", false);
  }
  async alarm(): Promise<void> {
    const now = Date.now();
    let next = Infinity;
    for (const ws of this.sockets()) {
      const a = this.attachment(ws);
      if (a.expires <= now || (a.pending && a.pending <= now)) {
        this.send(ws, {
          type: "error",
          message: "Request rejected or device unavailable",
        });
        ws.close(1008, "Expired");
      } else next = Math.min(next, a.expires, a.pending || Infinity);
    }
    if (Number.isFinite(next)) await this.ctx.storage.setAlarm(next);
  }
}
