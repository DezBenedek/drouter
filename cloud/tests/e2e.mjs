import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { createServer } from "node:net";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { generateKeyPairSync, createHash, sign } from "node:crypto";
import WebSocket from "ws";
import init from "../../firmware/web/shared/auth.js";
import { Client } from "../../firmware/web/shared/client.js";
import { checkInterfaces } from "./ui.mjs";
const root = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const state = await mkdtemp(path.join(tmpdir(), "drouter-e2e-"));
const setupToken = "test-physical-provisioning-token",
  control = "test-simulator-control-secret";
const local = "http://127.0.0.1:8080",
  cloud = "http://127.0.0.1:8787",
  password = "correct horse battery staple";
const nativeFetch = globalThis.fetch;
globalThis.location = { origin: cloud };
globalThis.fetch = (url, options) =>
  nativeFetch(
    typeof url === "string" && url.startsWith("/") ? `${local}${url}` : url,
    options,
  );
globalThis.WebSocket = class extends WebSocket {
  constructor(url) {
    super(url, { origin: cloud });
  }
};
await init({
  module_or_path: await readFile(
    path.join(root, "firmware/web/shared/auth_bg.wasm"),
  ),
});
const children = [];
let logs = "";
let simulator;
function start(command, args, options = {}) {
  const child = spawn(command, args, {
    cwd: root,
    detached: true,
    ...options,
    env: {
      ...process.env,
      CI: "true",
      WRANGLER_SEND_METRICS: "false",
      ...options.env,
    },
  });
  children.push(child);
  for (const stream of [child.stdout, child.stderr])
    stream?.on("data", (chunk) => {
      logs = (logs + chunk).slice(-20000);
    });
  return child;
}
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(fn, timeout = 30000) {
  const end = Date.now() + timeout;
  let last;
  while (Date.now() < end) {
    try {
      const result = await fn();
      if (result) return result;
    } catch (e) {
      last = e;
    }
    await delay(250);
  }
  throw last || new Error("Timed out");
}
async function stop(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const table = execFileSync("ps", ["-axo", "pid=,ppid="], { encoding: "utf8" })
    .trim()
    .split("\n")
    .map((line) => line.trim().split(/\s+/).map(Number));
  const descendants = new Set([child.pid]);
  for (let i = 0; i < table.length; i++)
    for (const [pid, parent] of table)
      if (descendants.has(parent)) descendants.add(pid);
  try {
    process.kill(-child.pid, "SIGINT");
  } catch (e) {
    if (e.code !== "ESRCH") throw e;
  }
  await Promise.race([new Promise((r) => child.once("exit", r)), delay(4000)]);
  for (const pid of [...descendants].reverse()) {
    try {
      process.kill(pid, "SIGTERM");
    } catch (e) {
      if (e.code !== "ESRCH") throw e;
    }
  }
}
async function requireFreePorts() {
  for (const port of [8080, 8787, 9001, 9002])
    await new Promise((resolve, reject) => {
      const server = createServer();
      server.once("error", () =>
        reject(
          new Error(
            `Port ${port} is already in use; stop development servers before running integration tests.`,
          ),
        ),
      );
      server.listen(port, "127.0.0.1", () => server.close(resolve));
    });
}

async function fault(v) {
  const r = await fetch(`${local}/sim/faults`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-simulator-token": control,
    },
    body: JSON.stringify(v),
  });
  assert.equal(r.status, 200);
  return r.json();
}
function startSimulator() {
  simulator = start(path.join(root, "target/debug/drouter-simulator"), [], {
    env: {
      DROUTER_STATE: state,
      DROUTER_SETUP_TOKEN: setupToken,
      DROUTER_SIM_CONTROL: control,
    },
  });
}
async function rawWs(url) {
  const ws = new WebSocket(url, { origin: cloud });
  const messages = [];
  const waiters = [];
  ws.on("message", (value) => {
    const frame = JSON.parse(value.toString());
    const waiter = waiters.shift();
    if (waiter) waiter(frame);
    else messages.push(frame);
  });
  await new Promise((resolve, reject) => {
    ws.once("open", resolve);
    ws.once("error", reject);
  });
  return {
    ws,
    send: (v) => ws.send(JSON.stringify(v)),
    next: () =>
      messages.length
        ? Promise.resolve(messages.shift())
        : new Promise((resolve, reject) => {
            const timer = setTimeout(
              () => reject(new Error("WebSocket timeout")),
              18000,
            );
            waiters.push((x) => {
              clearTimeout(timer);
              resolve(x);
            });
          }),
  };
}
let checks = 0;
const pass = (message) => {
  checks++;
  process.stdout.write(`✓ ${message}\n`);
};
try {
  await requireFreePorts();
  start(
    process.execPath,
    [
      path.join(root, "cloud/node_modules/wrangler/bin/wrangler.js"),
      "dev",
      "--ip",
      "127.0.0.1",
      "--port",
      "8787",
    ],
    { cwd: path.join(root, "cloud") },
  );
  startSimulator();
  await until(async () => {
    const r = await fetch(`${local}/bootstrap`);
    return r.ok;
  });
  await until(async () => {
    const r = await fetch(cloud);
    return r.ok;
  }, 60000);
  const setup = await fetch(`${local}/setup`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      token: setupToken,
      name: "studio-router",
      password,
      ethernet: {},
      cloud_enabled: false,
      wifi: { id: "school", ssid: "School-WiFi", password: "wifi-secret-1" },
    }),
  });
  assert.equal(setup.status, 200);
  let { remote_name: name } = await setup.json();
  pass("first boot provisions locally without Cloudflare");
  let localClient = await new Client().open("", password, false);
  await localClient.call("wifi.add", {
    id: "studio",
    ssid: "Studio-WiFi",
    password: "wifi-secret-2",
  });
  await localClient.call("wifi.add", {
    id: "backup",
    ssid: "Backup-Hotspot",
    password: "wifi-secret-3",
  });
  await localClient.call("wifi.reorder", {
    ids: ["backup", "studio", "school"],
  });
  assert.deepEqual(
    (await localClient.call("wifi.list")).map((x) => x.id),
    ["backup", "studio", "school"],
  );
  assert(
    !JSON.stringify(await localClient.call("wifi.list")).includes(
      "wifi-secret",
    ),
  );
  await assert.rejects(
    localClient.call("wifi.reorder", { ids: ["school", "school", "school"] }),
  );
  pass("Wi-Fi add, redaction, reorder and invalid reorder");
  const discovered = await localClient.call("receivers.discover");
  assert.equal(discovered.length, 2);
  for (const receiver of discovered)
    await localClient.call("receivers.add", receiver);
  const sourceB = "Studio (Camera B)",
    sourceA = "Studio (Camera A)",
    receiver = discovered[0].id;
  await localClient.call("route.set", { receiver, source: sourceB });
  assert.equal(
    (await (await fetch("http://127.0.0.1:9001/connectTo")).json()).sourceName,
    sourceB,
  );
  const preset = await localClient.call("presets.create", { name: "Opening" });
  pass("local routing changes actual virtual decoder and saves a preset");
  await fault({ receiver: 0, ignore_switch: true });
  await assert.rejects(
    localClient.call("route.set", { receiver, source: sourceA }),
    /did not confirm/,
  );
  await fault({ receiver: 0, ignore_switch: false });
  pass(
    "a transmitted switch is not reported as verified when the receiver ignores it",
  );
  let info = await localClient.call("device.info");
  await localClient.call("settings.update", {
    expected_revision: info.revision,
    server: cloud,
    cloud_enabled: true,
  });
  localClient.close();
  localClient = await new Client().open("", password, false);
  await until(async () => {
    return (await localClient.call("network.status")).cloud === "connected";
  });
  pass("device automatically registers with real local Durable Object relay");
  const wrong = new Client();
  await assert.rejects(wrong.open(name, "wrong password"));
  pass("wrong remote password is rejected");
  let remoteClient = await new Client().open(name, password);
  const read = await remoteClient.call("device.info");
  assert.equal(read.remote_name, name);
  await remoteClient.call("route.set", { receiver, source: sourceA });
  assert.equal(
    (await (await fetch("http://127.0.0.1:9001/connectTo")).json()).sourceName,
    sourceA,
  );
  pass(
    "browser-like SRP client routes actual virtual BirdDog through Wrangler relay",
  );
  await fault({ ethernet: false });
  await assert.rejects(
    remoteClient.call("route.set", { receiver, source: sourceB }),
    /Ethernet/,
  );
  await fault({ ethernet: true });
  pass("Ethernet failure is reported to the remote browser");
  await fault({ receiver: 1, online: false });
  const applied = await remoteClient.call("presets.apply", { id: preset.id });
  assert(applied.results.some((x) => !x.ok));
  assert(applied.results.some((x) => x.ok));
  await fault({ receiver: 1, online: true });
  pass("preset application returns per-output partial failures");
  await fault({ receiver: 0, delay_ms: 3000 });
  await assert.rejects(
    remoteClient.call("route.set", { receiver, source: sourceA }),
  );
  await fault({ receiver: 0, delay_ms: 0 });
  pass("BirdDog request timeout is bounded");
  await assert.rejects(
    remoteClient.call("http.fetch", { url: "http://127.0.0.1:9001" }),
  );
  pass("arbitrary HTTP proxy commands are rejected on the device");
  await fault({ cloud: false });
  await delay(1500);
  await localClient.call("route.set", { receiver, source: sourceA });
  assert.equal(
    (await (await fetch("http://127.0.0.1:9001/connectTo")).json()).sourceName,
    sourceA,
  );
  pass("cloud outage leaves local control operational");
  await fault({ cloud: true });
  await until(async () => {
    return (await localClient.call("network.status")).cloud === "connected";
  });
  remoteClient.close();
  remoteClient = await new Client().open(name, password);
  await remoteClient.call("route.set", { receiver, source: sourceB });
  pass("cloud reconnection restores authenticated remote routing");
  await checkInterfaces({ local, cloud, name, password, root });
  pass(
    "real Chromium local and React remote UIs route receivers; mobile layout verified",
  );
  const socket = await rawWs(`ws://127.0.0.1:8787/relay/${name}/browser`);
  await socket.next();
  socket.send({ type: "rpc", seq: 1, data: "abcd" });
  assert.equal((await socket.next()).type, "error");
  socket.ws.close();
  pass("unauthorized WebSocket cannot issue commands");
  const keys = generateKeyPairSync("ed25519"),
    publicKey = keys.publicKey
      .export({ format: "der", type: "spki" })
      .subarray(-32),
    ownedName = `test-device--${createHash("sha256").update(publicKey).digest("hex").slice(0, 32)}`;
  async function registration(socket) {
    const challenge = await socket.next();
    socket.send({
      type: "register",
      name: ownedName,
      publicKey: publicKey.toString("hex"),
      signature: sign(
        null,
        Buffer.from(`drouter-register-v1\n${ownedName}\n${challenge.nonce}`),
        keys.privateKey,
      ).toString("hex"),
    });
    return socket.next();
  }
  const owner = await rawWs(`ws://127.0.0.1:8787/relay/${ownedName}/device`);
  assert.equal((await registration(owner)).type, "registered");
  const duplicate = await rawWs(
    `ws://127.0.0.1:8787/relay/${ownedName}/device`,
  );
  assert.equal((await registration(duplicate)).type, "error");
  duplicate.ws.close();
  owner.ws.close();
  pass("duplicate live device identities are rejected");
  await delay(250);
  const resumed = await rawWs(`ws://127.0.0.1:8787/relay/${ownedName}/device`);
  assert.equal((await registration(resumed)).type, "registered");
  pass("the same identity reconnects after its previous socket closes");
  const timeoutBrowser = await rawWs(
    `ws://127.0.0.1:8787/relay/${ownedName}/browser`,
  );
  await timeoutBrowser.next();
  timeoutBrowser.send({ type: "auth.start", a: "ab".repeat(256) });
  assert.equal((await resumed.next()).type, "forward");
  assert.equal((await timeoutBrowser.next()).type, "error");
  timeoutBrowser.ws.close();
  resumed.ws.close();
  pass("the real relay expires unanswered requests without an unbounded queue");
  const spoof = await rawWs(`ws://127.0.0.1:8787/relay/${name}/device`);
  await spoof.next();
  spoof.send({
    type: "register",
    name,
    publicKey: publicKey.toString("hex"),
    signature: "00".repeat(64),
  });
  assert.equal((await spoof.next()).type, "error");
  spoof.ws.close();
  pass("name ownership cannot be transferred using another identity");
  const malformed = await rawWs(`ws://127.0.0.1:8787/relay/${name}/browser`);
  await malformed.next();
  malformed.ws.send("{");
  assert.equal((await malformed.next()).type, "error");
  malformed.ws.close();
  const oversized = await fetch(`${local}/api`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: " ".repeat(32769),
  });
  assert.equal(oversized.status, 413);
  pass("invalid JSON and oversized application requests are rejected");
  remoteClient.close();
  localClient.close();
  await stop(simulator);
  startSimulator();
  await until(async () => {
    const r = await fetch(`${local}/bootstrap`);
    return r.ok && !(await r.json()).setup;
  });
  localClient = await new Client().open("", password, false);
  assert(
    (await localClient.call("presets.list")).some((x) => x.name === "Opening"),
  );
  assert.deepEqual(
    (await localClient.call("wifi.list")).map((x) => x.id),
    ["backup", "studio", "school"],
  );
  assert.equal((await localClient.call("route.get"))[0].source, sourceA);
  pass(
    "presets and Wi-Fi priorities survive restart; live routing is read rather than restored",
  );
  await until(async () => {
    return (await localClient.call("network.status")).cloud === "connected";
  });
  remoteClient = await new Client().open(name, password);
  await remoteClient.call("device.health");
  pass("persistent device identity reconnects after simulator restart");
  await localClient.call("sessions.revoke");
  await assert.rejects(remoteClient.call("device.info"));
  pass("local session revocation invalidates remote controls");
  remoteClient.close();
  localClient.close();
  console.log(`\n${checks} integration checks passed.`);
} catch (e) {
  console.error(e);
  console.error(
    logs
      .replaceAll(setupToken, "[redacted]")
      .replaceAll(password, "[redacted]"),
  );
  process.exitCode = 1;
} finally {
  for (const child of children.reverse()) await stop(child);
  await rm(state, { recursive: true, force: true });
}
