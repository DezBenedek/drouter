import assert from "node:assert/strict";
import { chromium } from "@playwright/test";

export async function checkSessionReload({
  local,
  cloud,
  name,
  password,
  admin,
  fault,
  pass,
}) {
  const browser = await chromium.launch({ headless: true });
  const change = async (op, params) =>
    admin.call(op, {
      ...params,
      confirmed: true,
      expected_revision: (await admin.call("device.info")).revision,
    });
  const originalEvent = (await admin.call("device.info")).event_mode;
  if (originalEvent) await change("event.disable", {});
  try {
    for (const [kind, origin] of [
      ["local", local],
      ["remote", cloud],
    ]) {
      const context = await browser.newContext({
        viewport: { width: 1280, height: 900 },
      });
      const page = await context.newPage();
      const errors = [];
      page.on("pageerror", (error) => errors.push(error.message));
      const login = async (secret) => {
        if (kind === "remote")
          await page.getByLabel("Device name", { exact: true }).fill(name);
        await page.getByLabel("Password", { exact: true }).fill(secret);
        await page
          .getByRole("button", { name: "Connect", exact: true })
          .click();
      };
      const readSaved = () =>
        page.evaluate(() =>
          JSON.parse(sessionStorage.getItem("drouter-session-v1")),
        );
      const writeSaved = (saved) =>
        page.evaluate(
          (saved) =>
            sessionStorage.setItem("drouter-session-v1", JSON.stringify(saved)),
          saved,
        );
      const logoutAdmin = async () => {
        await page
          .getByRole("button", { name: "Settings", exact: true })
          .click();
        await page
          .getByRole("button", { name: "Disconnect", exact: true })
          .click();
        await page.getByLabel("Password", { exact: true }).waitFor();
      };
      let profileId;
      try {
        await page.goto(origin);
        await login(password);
        await page.locator(".crosspoint").first().waitFor();
        const first = await readSaved();
        assert(first.ticket && !JSON.stringify(first).includes(password));
        assert(first.expiresAt <= Date.now() + 21601000);
        for (let reload = 0; reload < 2; reload++) {
          await page.reload({ waitUntil: "domcontentloaded" });
          await page.locator(".crosspoint").first().waitFor();
        }
        const restored = await readSaved();
        assert.notEqual(restored.ticket, first.ticket);
        assert(restored.expiresAt <= first.expiresAt + 1200);
        const output = (await admin.call("receivers.list"))[0];
        const saved = await admin.call("sources.saved.list");
        const target = saved.find(
          (source) => source.source !== output.state.source,
        );
        assert(target);
        await fault({ receiver: 0, delay_ms: 400 });
        await page
          .getByRole("button", {
            name: `Route ${target.display_name} to ${output.config.label}`,
            exact: true,
          })
          .click();
        await page.locator(".crosspoint.pending").waitFor();
        await page.reload({ waitUntil: "domcontentloaded" });
        await page.locator(".crosspoint").first().waitFor();
        await fault({ receiver: 0, delay_ms: 0 });
        assert.equal(
          (await admin.call("receivers.list"))[0].state.source,
          target.source,
        );
        pass(
          `${kind}: repeated and in-flight reloads restore the administrator session with fresh keys and the original six-hour deadline`,
        );
        await logoutAdmin();
        await page.reload({ waitUntil: "domcontentloaded" });
        await page.getByLabel("Password", { exact: true }).waitFor();
        assert.equal(await readSaved(), null);
        const profileName = `Reload control ${kind}`;
        const profilePassword = `reload-access-92731-${kind}`;
        await change("simple.create", {
          name: profileName,
          password: profilePassword,
          actions: [
            {
              id: "reload-action",
              label: "Reload switch",
              icon: null,
              receiver: output.config.id,
              source: target.source,
              enabled: true,
              order: 0,
            },
          ],
        });
        profileId = (await admin.call("simple.list")).find(
          (profile) => profile.name === profileName,
        ).id;
        await login(profilePassword);
        await page
          .getByRole("heading", { name: profileName, exact: true })
          .waitFor();
        await page.reload({ waitUntil: "domcontentloaded" });
        await page
          .getByRole("heading", { name: profileName, exact: true })
          .waitFor();
        assert.equal(await page.locator(".crosspoint").count(), 0);
        assert.equal(
          await page
            .getByRole("button", { name: "Settings", exact: true })
            .count(),
          0,
        );
        await page
          .getByRole("button", { name: "Reload switch", exact: true })
          .click();
        await page
          .locator('.toast[data-kind="success"]')
          .filter({ hasText: "Routing verified" })
          .waitFor();
        const restricted = await readSaved();
        pass(
          `${kind}: Simple Mode survives reload and executes only its fixed scoped action`,
        );
        await page.getByRole("button", { name: "Logout", exact: true }).click();
        await page.getByLabel("Password", { exact: true }).waitFor();
        assert.equal(await readSaved(), null);
        // Even reinserting the old saved credential cannot undo an acknowledged logout.
        await page.waitForTimeout(300);
        await writeSaved(restricted);
        await page.reload({ waitUntil: "domcontentloaded" });
        await page.getByLabel("Password", { exact: true }).waitFor();
        assert.equal(await readSaved(), null);
        await login(password);
        await page.locator(".crosspoint").first().waitFor();
        const live = await readSaved();
        await writeSaved({ ...live, expiresAt: Date.now() - 1 });
        await page.reload({ waitUntil: "domcontentloaded" });
        await page.getByLabel("Password", { exact: true }).waitFor();
        assert.equal(await readSaved(), null);
        // Clean up the still-live device credential after the client-expiry scenario.
        await writeSaved(live);
        await page.reload({ waitUntil: "domcontentloaded" });
        await page.locator(".crosspoint").first().waitFor();
        await logoutAdmin();
        pass(
          `${kind}: logout revokes stored credentials and expired tab storage returns to login`,
        );
        assert.deepEqual(errors, []);
      } finally {
        await fault({ receiver: 0, delay_ms: 0 });
        if (profileId) await change("simple.delete", { id: profileId });
        await context.close();
      }
    }
  } finally {
    if (originalEvent) await change("event.enable", {});
    await browser.close();
  }
}
