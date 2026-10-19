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
import { modification3 } from "./modification3.mjs";
import { checkInterfaces, checkSetup } from "./ui.mjs";
const root = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const state = await mkdtemp(path.join(tmpdir(), "drouter-e2e-"));
const control = "test-simulator-control-secret";
const offset = Number(process.env.DROUTER_TEST_PORT_OFFSET || 0);
assert(Number.isInteger(offset) && offset >= 0 && offset <= 50000);
const localPort = 8080 + offset,
  cloudPort = 8787 + offset,
  birdPort = 9001 + offset;
const local = `http://127.0.0.1:${localPort}`,
  cloud = `http://127.0.0.1:${cloudPort}`,
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
  for (const port of [localPort, cloudPort, birdPort, birdPort + 1])
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
      DROUTER_PORT: String(localPort),
      DROUTER_BIRDDOG_PORT_BASE: String(birdPort),
      DROUTER_SIM_CONTROL: control,
    },
  });
}
function startWorker() {
  return start(
    process.execPath,
    [
      path.join(root, "cloud/node_modules/wrangler/bin/wrangler.js"),
      "dev",
      "--ip",
      "127.0.0.1",
      "--port",
      String(cloudPort),
      "--persist-to",
      path.join(state, "cloud"),
    ],
    { cwd: path.join(root, "cloud") },
  );
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
  let worker = startWorker();
  startSimulator();
  await until(async () => {
    const r = await fetch(`${local}/bootstrap`);
    return r.ok;
  });
  await until(async () => {
    const r = await fetch(cloud);
    return r.ok;
  }, 60000);
  const networkSetup = await fetch(`${local}/setup/network`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: local },
    body: "{}",
  });
  assert.equal(networkSetup.status, 200);
  assert(Array.isArray((await networkSetup.json()).networks));
  const crossOrigin = await fetch(`${local}/setup/network`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Origin: "https://untrusted.invalid",
    },
    body: "{}",
  });
  assert.equal(crossOrigin.status, 403);
  await checkSetup({ local, password, root });
  pass("mobile setup wizard needs no provisioning token and adds a network");
  assert.equal((await (await fetch(`${local}/bootstrap`)).json()).setup, false);
  let name = "studio-router";
  pass("first boot finishes the full local setup wizard without Cloudflare");
  const configuredSetup = await fetch(`${local}/setup/network`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: local },
    body: "{}",
  });
  assert.equal(configuredSetup.status, 409);
  assert.match((await configuredSetup.json()).error, /already complete/);
  pass(
    "token-free network setup rejects cross-origin requests and closes after provisioning",
  );

  let localClient = await new Client().open("", password, false);
  const school = (await localClient.call("wifi.list"))[0].id;
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
    ids: ["backup", "studio", school],
  });
  assert.deepEqual(
    (await localClient.call("wifi.list")).map((x) => x.id),
    ["backup", "studio", school],
  );
  assert(
    !JSON.stringify(await localClient.call("wifi.list")).includes(
      "wifi-secret",
    ),
  );
  await assert.rejects(
    localClient.call("wifi.reorder", { ids: [school, school, school] }),
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
    (await (await fetch(`http://127.0.0.1:${birdPort}/connectTo`)).json())
      .sourceName,
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
  await delay(2100);
  let remoteClient = await new Client().open(name, password);
  const read = await remoteClient.call("device.info");
  assert.equal(read.remote_name, name);
  await remoteClient.call("route.set", { receiver, source: sourceA });
  assert.equal(
    (await (await fetch(`http://127.0.0.1:${birdPort}/connectTo`)).json())
      .sourceName,
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
    remoteClient.call("http.fetch", { url: `http://127.0.0.1:${birdPort}` }),
  );
  pass("arbitrary HTTP proxy commands are rejected on the device");
  await fault({ cloud: false });
  await delay(1500);
  await localClient.call("route.set", { receiver, source: sourceA });
  assert.equal(
    (await (await fetch(`http://127.0.0.1:${birdPort}/connectTo`)).json())
      .sourceName,
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
  for (const source of [sourceA, sourceB]) {
    const revision = (await localClient.call("device.info")).revision;
    await localClient.call("sources.saved.add", {
      source,
      display_name: source,
      confirmed: true,
      expected_revision: revision,
    });
  }
  await checkInterfaces({ local, cloud, name, password, root, fault });
  pass(
    "real Chromium local and React remote UIs route receivers; mobile layout verified",
  );
  await modification3({
    admin: localClient,
    local,
    cloud,
    name,
    password,
    receivers: discovered,
    fault,
    pass,
    root,
  });
  await localClient.call("route.set", { receiver, source: sourceA });
  const socket = await rawWs(
    `ws://127.0.0.1:${cloudPort}/relay/${name}/browser`,
  );
  await socket.next();
  socket.send({ type: "rpc", seq: 1, data: "abcd" });
  assert.equal((await socket.next()).type, "error");
  socket.ws.close();
  pass("unauthorized WebSocket cannot issue commands");
  const keys = generateKeyPairSync("ed25519"),
    publicKey = keys.publicKey
      .export({ format: "der", type: "spki" })
      .subarray(-32),
    deviceId = createHash("sha256").update(publicKey).digest("hex"),
    ownedName = "registry-test-device";
  let lastProof;
  async function registration(
    socket,
    requestedName = ownedName,
    identity = keys,
    pub = publicKey,
  ) {
    const challenge = await socket.next();
    const id = createHash("sha256").update(pub).digest("hex");
    lastProof = {
      type: "register",
      deviceId: id,
      name: requestedName,
      publicKey: pub.toString("hex"),
      signature: sign(
        null,
        Buffer.from(
          `drouter-register-v2\n${id}\n${requestedName}\n${challenge.nonce}`,
        ),
        identity.privateKey,
      ).toString("hex"),
    };
    socket.send(lastProof);
    return socket.next();
  }
  const deviceUrl = (id) => `ws://127.0.0.1:${cloudPort}/relay/${id}/device`;
  const owner = await rawWs(deviceUrl(deviceId));
  assert.equal((await registration(owner)).type, "registered");
  const proof = lastProof;
  const duplicate = await rawWs(deviceUrl(deviceId));
  assert.equal((await registration(duplicate)).type, "error");
  duplicate.ws.close();
  owner.ws.close();
  await delay(300);
  pass("duplicate live identities are rejected");
  const replay = await rawWs(deviceUrl(deviceId));
  await replay.next();
  replay.send(proof);
  assert.equal((await replay.next()).type, "error");
  replay.ws.close();
  pass("registration challenges reject captured proof replay");
  const attackerKeys = generateKeyPairSync("ed25519"),
    attackerPub = attackerKeys.publicKey
      .export({ format: "der", type: "spki" })
      .subarray(-32),
    attackerId = createHash("sha256").update(attackerPub).digest("hex");
  const attacker = await rawWs(deviceUrl(attackerId));
  assert.equal(
    (await registration(attacker, ownedName, attackerKeys, attackerPub)).code,
    "name_unavailable",
  );
  attacker.ws.close();
  pass("offline names stay reserved and reject another valid identity");
  const resumed = await rawWs(deviceUrl(deviceId));
  const renamed = ownedName + "-renamed";
  assert.equal((await registration(resumed, renamed)).name, renamed);
  pass("the original identity reconnects and renames without changing its ID");
  const aliasAttacker = await rawWs(deviceUrl(attackerId));
  assert.equal(
    (await registration(aliasAttacker, ownedName, attackerKeys, attackerPub))
      .code,
    "name_unavailable",
  );
  aliasAttacker.ws.close();
  const timeoutBrowser = await rawWs(
    `ws://127.0.0.1:${cloudPort}/relay/${ownedName}/browser`,
  );
  await timeoutBrowser.next();
  timeoutBrowser.send({ type: "auth.start", a: "ab".repeat(256) });
  assert.equal((await resumed.next()).type, "forward");
  assert.equal((await timeoutBrowser.next()).type, "error");
  timeoutBrowser.ws.close();
  resumed.ws.close();
  pass(
    "old names resolve to the same owner and relay request timeouts remain bounded",
  );
  const spoof = await rawWs(deviceUrl(read.device_id));
  await spoof.next();
  spoof.send({
    ...lastProof,
    deviceId: read.device_id,
    name,
    signature: "00".repeat(64),
  });
  assert.equal((await spoof.next()).type, "error");
  spoof.ws.close();
  pass("device impersonation with another public key is rejected");
  const malformed = await rawWs(
    `ws://127.0.0.1:${cloudPort}/relay/${name}/browser`,
  );
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
    ["backup", "studio", school],
  );
  assert.equal((await localClient.call("route.get"))[0].source, sourceA);
  assert.equal((await localClient.call("event.status")).enabled, true);
  assert.equal((await localClient.call("simple.list")).length, 2);
  assert(
    (await localClient.call("sources.saved.list")).some(
      (s) => s.display_name === "Teacher PC",
    ),
  );
  await localClient.call("event.disable", {
    confirmed: true,
    expected_revision: (await localClient.call("device.info")).revision,
  });
  pass(
    "saved aliases, profiles, and Event Mode persist across an actual simulator restart",
  );
  pass(
    "presets and Wi-Fi priorities survive restart; live routing is read rather than restored",
  );
  await until(async () => {
    return (await localClient.call("network.status")).cloud === "connected";
  });
  remoteClient = await new Client().open(name, password);
  await remoteClient.call("device.health");
  pass("persistent device identity reconnects after simulator restart");
  remoteClient.close();
  await stop(worker);
  worker = startWorker();
  await until(async () => (await fetch(cloud)).ok, 60000);
  await until(
    async () =>
      (await localClient.call("network.status")).cloud === "connected",
    60000,
  );
  remoteClient = await new Client().open(name, password);
  await remoteClient.call("device.health");
  const afterRestart = await rawWs(deviceUrl(attackerId));
  assert.equal(
    (await registration(afterRestart, ownedName, attackerKeys, attackerPub))
      .code,
    "name_unavailable",
  );
  afterRestart.ws.close();
  pass(
    "SQLite reservations survive a complete Worker restart while the owner reconnects",
  );
  const registryRows = JSON.parse(
    execFileSync(
      "python3",
      [
        "-c",
        `import sqlite3,pathlib,json,sys
out=[]
for p in pathlib.Path(sys.argv[1]).rglob('*.sqlite'):
 c=sqlite3.connect('file:'+str(p)+'?mode=ro',uri=True)
 if c.execute("SELECT name FROM sqlite_master WHERE type='table' AND name='devices'").fetchone():
  out.append({'columns':[x[1] for x in c.execute('PRAGMA table_info(devices)')],'devices':list(c.execute('SELECT * FROM devices')),'names':list(c.execute('SELECT * FROM names'))})
print(json.dumps(out))`,
        path.join(state, "cloud"),
      ],
      { encoding: "utf8" },
    ),
  );
  assert.equal(registryRows.length, 1);
  assert.deepEqual(registryRows[0].columns, [
    "device_id",
    "name",
    "public_key",
    "registered_at",
    "renamed_at",
    "last_connected",
  ]);
  assert(registryRows[0].names.some((r) => r[0] === ownedName));
  assert(!JSON.stringify(registryRows).includes(password));
  assert(!JSON.stringify(registryRows).includes("wifi-secret"));
  assert(!JSON.stringify(registryRows).includes("Opening"));
  assert(!JSON.stringify(registryRows).includes("Classroom"));
  assert(!JSON.stringify(registryRows).includes("Teacher PC"));
  pass(
    "actual persisted registry has only public identity metadata, with no device configuration or credentials",
  );
  await localClient.call("sessions.revoke");
  await assert.rejects(remoteClient.call("device.info"));
  pass("local session revocation invalidates remote controls");
  localClient.close();
  localClient = await new Client().open("", password, false);
  const recovery = await localClient.call("identity.export");
  const changedPassword = "new device password for secure tests";
  const beforeChange = await localClient.call("device.info");
  await localClient.call("settings.update", {
    expected_revision: beforeChange.revision,
    password: changedPassword,
  });
  localClient.close();
  await assert.rejects(new Client().open(name, password));
  await delay(4100);
  remoteClient = await new Client().open(name, changedPassword);
  assert.equal(
    (await remoteClient.call("device.info")).device_id,
    recovery.device_id,
  );
  pass(
    "device-only password change rejects the old password without changing reserved identity",
  );
  localClient = await new Client().open("", changedPassword, false);
  const beforeRestore = await localClient.call("device.info");
  await assert.rejects(remoteClient.call("identity.export"), /local access/);
  await localClient.call("identity.restore", {
    identity: recovery.identity,
    name,
    password,
    expected_revision: beforeRestore.revision,
  });
  await assert.rejects(remoteClient.call("device.info"));
  localClient.close();
  remoteClient.close();
  remoteClient = await new Client().open(name, password);
  assert.equal(
    (await remoteClient.call("device.info")).device_id,
    recovery.device_id,
  );
  pass(
    "local identity recovery rekeys password authentication, preserves reservation, and revokes remote sessions",
  );

  remoteClient.close();
  localClient.close();
  console.log(`\n${checks} integration checks passed.`);
} catch (e) {
  console.error(e);
  console.error(logs.replaceAll(password, "[redacted]"));
  process.exitCode = 1;
} finally {
  for (const child of children.reverse()) await stop(child);
  await rm(state, { recursive: true, force: true });
}
