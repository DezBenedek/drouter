import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { createServer } from "node:net";
import { chromium } from "@playwright/test";
import WebSocket from "ws";
import init from "../../firmware/web/shared/auth.js";
import { Client } from "../../firmware/web/shared/client.js";
const cloud = process.env.DROUTER_LIVE_ORIGIN;
assert(
  cloud && new URL(cloud).protocol === "https:",
  "Set DROUTER_LIVE_ORIGIN to the deployed HTTPS Worker origin",
);
const root = path.resolve(import.meta.dirname, "../..");
for (const port of [18081, 19011, 19012]) {
  await new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", () =>
      reject(
        new Error(
          `Port ${port} is already in use; live verification must use isolated ports`,
        ),
      ),
    );
    server.listen(port, "127.0.0.1", () => server.close(resolve));
  });
}
const state = await mkdtemp(path.join(tmpdir(), "drouter-live-"));
const local = "http://127.0.0.1:18081";
const name = `deploy-check-${randomBytes(5).toString("hex")}`;
const password = randomBytes(24).toString("hex");
const simplePassword = randomBytes(16).toString("hex");
const nativeFetch = globalThis.fetch;
globalThis.fetch = (url, options) =>
  nativeFetch(
    typeof url === "string" && url.startsWith("/") ? local + url : url,
    options,
  );
globalThis.location = { origin: cloud };
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
const child = spawn(path.join(root, "target/debug/drouter-simulator"), [], {
  cwd: root,
  env: {
    ...process.env,
    DROUTER_STATE: state,
    DROUTER_PORT: "18081",
    DROUTER_BIRDDOG_PORT_BASE: "19011",
  },
  stdio: ["ignore", "pipe", "pipe"],
});
let logs = "",
  browser,
  localClient,
  admin,
  simple;
child.stdout.on("data", (data) => {
  logs = (logs + data).slice(-3000);
});
child.stderr.on("data", (data) => {
  logs = (logs + data).slice(-3000);
});
async function until(fn, timeout = 60000) {
  const end = Date.now() + timeout;
  let error;
  while (Date.now() < end) {
    try {
      const value = await fn();
      if (value) return value;
    } catch (e) {
      error = e;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw error || Error("Timed out waiting for deployed relay");
}
try {
  await until(async () => (await fetch(local + "/bootstrap")).ok);
  const setup = await fetch(local + "/setup", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      name,
      password,
      ethernet: {},
      cloud_enabled: false,
    }),
  });
  assert.equal(setup.status, 200);
  localClient = await new Client().open("", password, false);
  const receivers = await localClient.call("receivers.discover");
  assert.equal(receivers.length, 2);
  for (const receiver of receivers)
    await localClient.call("receivers.add", receiver);
  await localClient.call("settings.update", {
    server: cloud,
    cloud_enabled: true,
    expected_revision: (await localClient.call("device.info")).revision,
  });
  localClient.close();
  localClient = await new Client().open("", password, false);
  await until(
    async () =>
      (await localClient.call("network.status")).cloud === "connected",
  );
  console.log(
    "PASS localhost simulator registered with the deployed Cloudflare relay",
  );
  admin = await new Client().open(name, password, true, cloud);
  assert.equal((await admin.call("auth.session")).role, "admin");
  await admin.call("route.set", {
    receiver: receivers[0].id,
    source: "Studio (Camera B)",
  });
  assert.equal(
    (await (await fetch("http://127.0.0.1:19011/connectTo")).json()).sourceName,
    "Studio (Camera B)",
  );
  console.log(
    "PASS remote administrator authentication and verified BirdDog routing over public WSS",
  );
  const change = async (op, params = {}) =>
    admin.call(op, {
      ...params,
      confirmed: true,
      expected_revision: (await admin.call("device.info")).revision,
    });
  await change("simple.create", {
    name: "Live relay check",
    password: simplePassword,
    actions: [
      {
        id: "camera",
        label: "Camera",
        icon: null,
        receiver: receivers[1].id,
        source: "Studio (Camera B)",
        enabled: true,
        order: 0,
      },
    ],
  });
  simple = await new Client().open(name, simplePassword, true, cloud);
  assert.equal((await simple.call("auth.session")).role, "simple_mode");
  await assert.rejects(simple.call("wifi.list"), /Administrator/);
  await simple.call("simple.action.execute", { id: "camera" });
  assert.equal(
    (await (await fetch("http://127.0.0.1:19012/connectTo")).json()).sourceName,
    "Studio (Camera B)",
  );
  await change("event.enable");
  await assert.rejects(
    simple.call("simple.action.execute", { id: "camera" }),
    /event_locked/,
  );
  await admin.call("route.set", {
    receiver: receivers[0].id,
    source: "Studio (Camera A)",
  });
  await change("event.disable");
  console.log(
    "PASS remote Simple Mode authorization and firmware-enforced Event Mode",
  );
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 375, height: 844 } });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(cloud);
  await page.getByLabel("Device name", { exact: true }).fill(name);
  await page.getByLabel("Password", { exact: true }).fill(password);
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await page
    .getByRole("heading", { name: "Routing", exact: true })
    .waitFor({ timeout: 60000 });
  await page.locator(".output-open").first().waitFor();
  assert.equal(
    await page.evaluate(
      () => document.documentElement.scrollWidth > innerWidth,
    ),
    false,
  );
  assert.deepEqual(errors, []);
  console.log(
    "PASS deployed React mobile interface connects through the public relay",
  );
  console.log(`Live deployment verified: ${cloud}`);
  console.log(`Minimal test-device registration retained by design: ${name}`);
} catch (error) {
  console.error(logs);
  throw error;
} finally {
  await browser?.close();
  simple?.close();
  admin?.close();
  localClient?.close();
  if (child.exitCode === null && child.signalCode === null) {
    child.kill("SIGTERM");
    await new Promise((resolve) => child.once("exit", resolve));
  }
  await rm(state, { recursive: true, force: true });
}
