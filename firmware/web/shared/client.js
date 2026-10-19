import init, { Login } from "./auth.js";
import { gcm, hkdf, sha256 } from "./crypto.js";
export const randomId = () =>
  Array.from(crypto.getRandomValues(new Uint8Array(8)), (x) =>
    x.toString(16).padStart(2, "0"),
  ).join("");
export function remoteStatus(state) {
  return (
    {
      connected: "Connected",
      connecting: "Connecting…",
      disabled: "Disabled",
      offline: "Waiting for connection",
      name_unavailable:
        "Name belongs to another device. Choose another name or restore its identity.",
      registry_unavailable:
        "Registration service unavailable. Retrying automatically.",
      identity_in_use:
        "This device identity is already connected. Stop its other instance.",
      identity_rejected:
        "Device identity could not be verified. Check the identity recovery file.",
    }[state] || "Waiting for connection"
  );
}
const encoder = new TextEncoder();
const decoder = new TextDecoder();
const unhex = (s) =>
  Uint8Array.from(s.match(/../g) || [], (x) => parseInt(x, 16));
const hex = (b) =>
  Array.from(new Uint8Array(b), (x) => x.toString(16).padStart(2, "0")).join(
    "",
  );
let loaded;
export class Client {
  constructor() {
    this.sid = "";
    this.key = null;
    this.seq = 0;
    this.rx = 0;
    this.serial = Promise.resolve();
    this.onDisconnect = () => {};
  }
  async open(name, password, remote = true, origin = location.origin) {
    if (Array.from(password).length < 4 || Array.from(password).length > 128)
      throw new Error("Password must contain 4–128 Unicode characters");
    loaded ||= init();
    await loaded;
    if (remote) {
      const ws = new WebSocket(
        `${origin.replace(/^http/, "ws")}/relay/${encodeURIComponent(name)}/browser`,
      );
      this.ws = ws;
      this.messages = [];
      this.waiters = [];
      ws.onmessage = (e) => {
        try {
          const value = JSON.parse(e.data);
          if (value.type === "offline") {
            this.close();
            return;
          }
          const waiter = this.waiters.shift();
          if (waiter) waiter.resolve(value);
          else if (this.messages.length < 8) this.messages.push(value);
          else this.close();
        } catch {
          this.close();
        }
      };
      ws.onclose = () => {
        this.key?.fill(0);
        this.key = null;
        this.waiters
          .splice(0)
          .forEach((w) =>
            w.reject(new Error("Connection closed. Reconnect to continue.")),
          );
        this.onDisconnect();
      };
      const hello = await this.read();
      if (hello.type !== "hello") throw new Error("Unable to connect");
      this.sid = hello.sid;
    } else {
      this.sid = (
        await (await fetch("/session", { method: "POST" })).json()
      ).sid;
    }
    const login = new Login();
    try {
      const challenge = await this.exchange({
        type: "auth.start",
        a: login.public_key(),
        multi: true,
      });
      if (challenge.type !== "auth.challenge")
        throw new Error("Unable to connect. Check device name and password.");
      const proof = login.respond(password, challenge.salt, challenge.b);
      const proofs = [
        proof,
        ...(challenge.alternatives || []).map((c) =>
          login.respond(password, c.salt, c.b),
        ),
      ];
      const result = await this.exchange({ type: "auth.proof", proof, proofs });
      const key = result.type === "auth.ok" ? login.finish(result.proof) : "";
      if (!key)
        throw new Error("Unable to connect. Check device name and password.");
      this.key = unhex(key);
      this.seq = 0;
      this.rx = 0;
    } catch (e) {
      this.close();
      throw e;
    } finally {
      login.free();
    }
    return this;
  }
  read() {
    if (this.messages.length) return Promise.resolve(this.messages.shift());
    return new Promise((resolve, reject) => {
      const waiter = {
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      };
      const timer = setTimeout(() => {
        const i = this.waiters.indexOf(waiter);
        if (i >= 0) this.waiters.splice(i, 1);
        this.close();
        reject(new Error("Device request timed out"));
      }, 17000);
      this.waiters.push(waiter);
    });
  }
  async exchange(frame) {
    if (this.ws) {
      const pending = this.read();
      this.ws.send(JSON.stringify(frame));
      return pending;
    }
    const response = await fetch("/api", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sid: this.sid, frame }),
      signal: AbortSignal.timeout(17000),
    });
    if (!response.ok) throw new Error("Device unavailable");
    return response.json();
  }
  call(op, params = {}) {
    if (
      (op === "settings.update" || op === "auth.password.change") &&
      params.password !== undefined &&
      (Array.from(params.password).length < 4 ||
        Array.from(params.password).length > 128)
    )
      return Promise.reject(
        new Error("Password must contain 4–128 Unicode characters"),
      );
    const work = this.serial.then(() => this.request(op, params));
    this.serial = work.catch(() => {});
    return work;
  }
  async crypt(encrypt, response, seq, bytes) {
    const key = hkdf(
      sha256,
      this.key,
      encoder.encode(this.sid),
      encoder.encode(response ? "drouter-response-v1" : "drouter-request-v1"),
      32,
    );
    const iv = new Uint8Array(12);
    new DataView(iv.buffer).setBigUint64(4, BigInt(seq));
    const cipher = gcm(key, iv, encoder.encode(`${this.sid}:${seq}`));
    try {
      return encrypt ? cipher.encrypt(bytes) : cipher.decrypt(bytes);
    } finally {
      key.fill(0);
    }
  }
  async request(op, params) {
    if (!this.key) throw new Error("Reconnect to continue");
    let reply;
    try {
      const seq = ++this.seq,
        id = String(seq);
      const data = hex(
        await this.crypt(
          true,
          false,
          seq,
          encoder.encode(JSON.stringify({ v: 1, id, op, params })),
        ),
      );
      const frame = await this.exchange({ type: "rpc", seq, data });
      if (frame.type !== "rpc" || frame.seq !== this.rx + 1) {
        this.close();
        throw new Error("Session expired. Reconnect to continue.");
      }
      reply = JSON.parse(
        decoder.decode(
          await this.crypt(false, true, frame.seq, unhex(frame.data)),
        ),
      );
      this.rx = frame.seq;
      if (reply.id !== id) {
        this.close();
        throw new Error("Invalid response");
      }
    } catch (e) {
      this.close();
      this.onDisconnect();
      throw e;
    }
    if (!reply.ok) {
      const error = new Error(reply.error.message);
      error.code = reply.error.code;
      throw error;
    }
    return reply.result;
  }
  close() {
    if (this.key && !this.ws) {
      const seq = ++this.seq;
      const payload = encoder.encode(
        JSON.stringify({
          v: 1,
          id: String(seq),
          op: "auth.logout",
          params: {},
        }),
      );
      void this.crypt(true, false, seq, payload)
        .then((data) =>
          fetch("/api", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              sid: this.sid,
              frame: { type: "rpc", seq, data: hex(data) },
            }),
            keepalive: true,
          }),
        )
        .catch(() => {});
    }
    this.key?.fill(0);
    this.key = null;
    if (this.ws && this.ws.readyState < 2) this.ws.close();
  }
}
