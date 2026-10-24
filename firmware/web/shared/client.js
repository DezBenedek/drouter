import init, { Login } from "./auth.js";
import { gcm, hkdf, sha256, hmac } from "./crypto.js";
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
const savedSessionKey = "drouter-session-v1";
const resumeTranscript = (kind, sid, ticket, nonce) =>
  encoder.encode(`drouter-resume-v1\n${kind}\n${sid}\n${ticket}\n${nonce}`);
const resumeProof = (secret, kind, sid, ticket, nonce) =>
  hex(hmac(sha256, secret, resumeTranscript(kind, sid, ticket, nonce)));
globalThis.addEventListener?.("pageshow", (event) => {
  if (event.persisted) location.reload();
});
let loaded;
export class Client {
  constructor() {
    this.sid = "";
    this.key = null;
    this.seq = 0;
    this.rx = 0;
    this.queue = [];
    this.processing = false;
    this.onDisconnect = () => {};
    this.resumeId = "";
    this.leaving = false;
    this.closing = false;
    this.pageHide = () => this.suspend();
    globalThis.addEventListener?.("pagehide", this.pageHide);
  }
  async open(name, password, remote = true, origin = location.origin) {
    if (Array.from(password).length < 4 || Array.from(password).length > 128)
      throw new Error("Password must contain 4–128 Unicode characters");
    loaded ||= init();
    await loaded;
    await this.transport(name, remote, origin);
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
    await this.remember();
    return this;
  }
  async transport(name, remote, origin) {
    this.name = name;
    this.remote = remote;
    this.origin = new URL(origin).origin;
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
            this.failConnection();
            return;
          }
          const waiter = this.waiters.shift();
          if (waiter) waiter.resolve(value);
          else if (this.messages.length < 8) this.messages.push(value);
          else this.failConnection();
        } catch {
          this.failConnection();
        }
      };
      ws.onclose = () => {
        if (this.leaving || this.closing) return;
        this.forget();
        this.destroy();
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
  }
  static async restore({
    remote = true,
    name = "",
    origin = location.origin,
  } = {}) {
    let saved;
    try {
      saved = JSON.parse(sessionStorage.getItem(savedSessionKey) || "null");
    } catch {
      return null;
    }
    if (
      !saved ||
      saved.remote !== remote ||
      saved.origin !== new URL(origin).origin ||
      (name && name !== saved.name)
    )
      return null;
    if (
      !/^[a-f0-9]{32}$/.test(saved.ticket) ||
      !/^[a-f0-9]{64}$/.test(saved.secret) ||
      typeof saved.name !== "string" ||
      !Number.isFinite(saved.expiresAt) ||
      saved.expiresAt <= Date.now()
    ) {
      try {
        sessionStorage.removeItem(savedSessionKey);
      } catch {}
      return null;
    }
    const client = new Client();
    client.resumeId = saved.ticket;
    const secret = unhex(saved.secret);
    try {
      await client.transport(saved.name, remote, origin);
      const challenge = await client.exchange({
        type: "auth.resume.start",
        ticket: saved.ticket,
      });
      if (
        challenge.type !== "auth.resume.challenge" ||
        !/^[a-f0-9]{64}$/.test(challenge.nonce) ||
        challenge.proof !==
          resumeProof(
            secret,
            "server",
            client.sid,
            saved.ticket,
            challenge.nonce,
          )
      )
        throw Error("Unable to resume session");
      const result = await client.exchange({
        type: "auth.resume.proof",
        proof: resumeProof(
          secret,
          "client",
          client.sid,
          saved.ticket,
          challenge.nonce,
        ),
      });
      if (
        result.type !== "auth.resumed" ||
        result.proof !==
          resumeProof(
            secret,
            "accepted",
            client.sid,
            saved.ticket,
            challenge.nonce,
          )
      )
        throw Error("Unable to resume session");
      client.key = hkdf(
        sha256,
        secret,
        unhex(challenge.nonce),
        encoder.encode(`drouter-resume-key-v1\n${client.sid}\n${saved.ticket}`),
        32,
      );
      client.seq = 0;
      client.rx = 0;
      await client.remember();
      return client;
    } catch {
      client.forget();
      client.destroy();
      return null;
    } finally {
      secret.fill(0);
    }
  }
  async remember() {
    if (typeof sessionStorage === "undefined") return;
    try {
      const saved = await this.call("auth.resume.create");
      if (this.leaving || this.closing) return;
      this.resumeId = saved.ticket;
      sessionStorage.setItem(
        savedSessionKey,
        JSON.stringify({
          remote: this.remote,
          origin: this.origin,
          name: this.name,
          ticket: saved.ticket,
          secret: saved.secret,
          expiresAt: Date.now() + saved.expiresIn * 1000,
        }),
      );
    } catch {
      if (!this.leaving) this.forget();
    }
  }
  forget() {
    try {
      const saved = JSON.parse(
        sessionStorage.getItem(savedSessionKey) || "null",
      );
      if (saved?.ticket === this.resumeId)
        sessionStorage.removeItem(savedSessionKey);
    } catch {}
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
        this.failConnection();
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
    if (this.closing || this.leaving)
      return Promise.reject(
        new Error("Connection closed. Reconnect to continue."),
      );
    if (
      (op === "settings.update" || op === "auth.password.change") &&
      params.password !== undefined &&
      (Array.from(params.password).length < 4 ||
        Array.from(params.password).length > 128)
    )
      return Promise.reject(
        new Error("Password must contain 4–128 Unicode characters"),
      );
    return new Promise((resolve, reject) => {
      this.queue.push({ op, params, resolve, reject });
      if (!this.processing) {
        this.processing = true;
        queueMicrotask(() => this.drain());
      }
    });
  }
  async drain() {
    while (this.queue.length) {
      // Switching can pass unsent background reads, while mutations retain their order.
      // Only one encrypted exchange runs at a time, preserving directional sequence numbers.
      let index = 0;
      for (let i = 0; i < this.queue.length; i++) {
        const op = this.queue[i].op;
        if (
          [
            "route.set",
            "simple.action.execute",
            "route.repair",
            "simple.repair",
          ].includes(op)
        ) {
          index = i;
          break;
        }
        if (!/\.(list|get|status|info|health)$/.test(op)) break;
      }
      const item = this.queue.splice(index, 1)[0];
      const request = this.request(item.op, item.params);
      this.inFlight = request;
      try {
        item.resolve(await request);
      } catch (error) {
        item.reject(error);
      } finally {
        if (this.inFlight === request) this.inFlight = null;
      }
    }
    this.processing = false;
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
        this.failConnection();
        throw new Error("Session expired. Reconnect to continue.");
      }
      reply = JSON.parse(
        decoder.decode(
          await this.crypt(false, true, frame.seq, unhex(frame.data)),
        ),
      );
      this.rx = frame.seq;
      if (reply.id !== id) {
        this.failConnection();
        throw new Error("Invalid response");
      }
    } catch (e) {
      this.failConnection();
      throw e;
    }
    if (!reply.ok) {
      const error = new Error(reply.error.message);
      error.code = reply.error.code;
      throw error;
    }
    return reply.result;
  }
  suspend() {
    if (this.leaving || this.closing) return;
    this.leaving = true;
    // A remote socket detaches via relay leave. Local HTTP has no connection-close event.
    if (this.key && !this.ws && !this.processing) {
      const sid = this.sid,
        seq = ++this.seq;
      void this.crypt(
        true,
        false,
        seq,
        encoder.encode(
          JSON.stringify({
            v: 1,
            id: String(seq),
            op: "auth.detach",
            params: {},
          }),
        ),
      )
        .then((data) =>
          fetch("/api", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              sid,
              frame: { type: "rpc", seq, data: hex(data) },
            }),
            keepalive: true,
          }),
        )
        .catch(() => {});
    }
    this.destroy();
  }
  failConnection() {
    if (this.leaving || this.closing || this.failed) return;
    this.failed = true;
    this.forget();
    this.destroy();
    this.onDisconnect();
  }
  destroy() {
    this.key?.fill(0);
    this.key = null;
    globalThis.removeEventListener?.("pagehide", this.pageHide);
    const error = new Error("Connection closed. Reconnect to continue.");
    this.queue.splice(0).forEach((item) => item.reject(error));
    this.waiters?.splice(0).forEach((waiter) => waiter.reject(error));
    if (this.ws) {
      this.ws.onclose = null;
      if (this.ws.readyState < 2) this.ws.close();
    }
  }
  close() {
    if (this.leaving) {
      this.destroy();
      return;
    }
    if (this.closing) return;
    this.closing = true;
    this.forget();
    this.queue
      .splice(0)
      .forEach((item) =>
        item.reject(new Error("Connection closed. Reconnect to continue.")),
      );
    const pending = this.inFlight || Promise.resolve();
    void pending
      .catch(() => {})
      .then(async () => {
        if (this.key && (!this.ws || this.ws.readyState === 1)) {
          try {
            await this.request("auth.logout", {});
          } catch {}
        }
      })
      .finally(() => this.destroy());
  }
}
