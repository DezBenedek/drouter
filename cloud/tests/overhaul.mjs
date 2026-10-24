import assert from "node:assert/strict";
import { chromium } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

// End-to-end acceptance against the real simulator and Cloudflare relay.
export async function checkOverhaul({
  local,
  cloud,
  name,
  password,
  root,
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
  let activePage;
  try {
    for (const [kind, origin] of [
      ["local", local],
      ["remote", cloud],
    ]) {
      const context = await browser.newContext({
        viewport: { width: 1440, height: 1000 },
      });
      const p = await context.newPage();
      activePage = p;
      const errors = [];
      p.on("pageerror", (e) => errors.push(e.message));
      await p.goto(origin);
      if (kind === "remote")
        await p.getByLabel("Device name", { exact: true }).fill(name);
      await p.getByLabel("Password", { exact: true }).fill(password);
      await p.getByRole("button", { name: "Connect", exact: true }).click();
      await p.locator(".crosspoint").first().waitFor();
      const matrix = p.locator(".matrix-scroll");
      const beforeHover = await matrix.innerHTML();
      await p.locator(".crosspoint").first().hover();
      await p.locator(".crosspoint").last().hover();
      await p.locator(".crosspoint").first().hover();
      assert.equal(
        await matrix.innerHTML(),
        beforeHover,
        "Hover must not modify the matrix DOM",
      );
      // A route button survives pending, readback and a failed subsequent switch.
      const outputs = await admin.call("receivers.list");
      const actual = outputs[0].state.source;
      const targetSource =
        actual === "Studio (Camera A)"
          ? "Studio (Camera B)"
          : "Studio (Camera A)";
      const buttonFor = (source) =>
        p.getByRole("button", {
          name: `Route ${source} to ${outputs[0].config.label}`,
          exact: true,
        });
      const target = buttonFor(targetSource);
      const originalNode = await target.elementHandle();
      await fault({ receiver: 0, delay_ms: 400 });
      try {
        await target.click();
        assert.equal(
          await target.getAttribute("aria-pressed"),
          "false",
          "Pending routes are never displayed as active",
        );
        assert.equal(
          await target.locator(".crosspoint-copy").innerText(),
          "Switching…",
        );
        assert(
          await target.evaluate(
            (node, original) => node === original,
            originalNode,
          ),
          "Pending state preserves the button node",
        );
        await p.waitForFunction(
          (label) =>
            document
              .querySelector(`[aria-label="${label}"]`)
              ?.getAttribute("aria-pressed") === "true",
          `Route ${targetSource} to ${outputs[0].config.label}`,
        );
        await p.waitForFunction(
          () => !document.querySelector(".crosspoint:disabled"),
        );
        assert.equal(
          await target.locator(".crosspoint-copy").innerText(),
          "Active",
        );
        assert(
          await target.evaluate(
            (node, original) => node === original,
            originalNode,
          ),
          "Verified state preserves the button node",
        );
        await fault({ receiver: 0, delay_ms: 0, ignore_switch: true });
        await buttonFor(actual).click();
        await p
          .locator('.toast[data-kind="error"]')
          .filter({ hasText: outputs[0].config.label })
          .waitFor();
        await p.waitForFunction(
          () => !document.querySelector(".crosspoint:disabled"),
        );
        assert.equal(
          await target.getAttribute("aria-pressed"),
          "true",
          "Failed switches keep the verified active route",
        );
        assert.equal(
          await buttonFor(actual).getAttribute("aria-pressed"),
          "false",
        );
      } finally {
        await fault({ receiver: 0, delay_ms: 0, ignore_switch: false });
        await originalNode.dispose();
      }
      const eventSwitch = p.getByRole("switch", {
        name: "Event Mode",
        exact: true,
      });
      for (const enabled of [false, true, false]) {
        if ((await admin.call("event.status")).enabled === enabled) continue;
        await eventSwitch.click();
        await p.getByRole("dialog").waitFor();
        assert.equal(await p.locator("dialog[open]").count(), 1);
        await p
          .getByRole("dialog")
          .getByRole("button", { name: "Confirm", exact: true })
          .click();
        await p.getByRole("dialog").waitFor({ state: "detached" });
        assert.equal((await admin.call("event.status")).enabled, enabled);
      }
      const saved = (await admin.call("sources.saved.list"))[0];
      await p
        .getByRole("button", { name: "Edit source", exact: true })
        .first()
        .click();
      await p
        .getByLabel("Display name", { exact: true })
        .fill("Temporary alias");
      await p
        .getByRole("dialog")
        .getByRole("button", { name: "Cancel", exact: true })
        .click();
      assert.equal(
        (await admin.call("sources.saved.list"))[0].display_name,
        saved.display_name,
      );
      await p
        .getByRole("button", { name: "Edit source", exact: true })
        .first()
        .click();
      await p
        .getByLabel("Display name", { exact: true })
        .fill("Temporary alias");
      await p
        .getByRole("dialog")
        .getByRole("button", { name: "Save", exact: true })
        .click();
      await p
        .getByRole("dialog")
        .waitFor({ state: "detached" })
        .catch(async (error) => {
          console.error(await p.locator("body").innerText());
          throw error;
        });
      assert.equal(
        (await admin.call("sources.saved.list"))[0].source,
        saved.source,
      );
      assert.equal(
        (await admin.call("sources.saved.list"))[0].display_name,
        "Temporary alias",
      );
      await change("sources.saved.update", {
        id: saved.id,
        display_name: saved.display_name,
      });
      const originalOrder = (await admin.call("receivers.list")).map(
        (r) => r.config.id,
      );
      await p.getByRole("button", { name: "Reorder", exact: true }).click();
      await p.locator('[data-control="receiver-down"]').first().click();
      await p.waitForFunction(
        (id) =>
          document
            .querySelector('[data-control="receiver-edit"]')
            ?.getAttribute("data-id") === id,
        originalOrder.at(-1),
      );
      assert.deepEqual(
        (await admin.call("receivers.list")).map((r) => r.config.id),
        [...originalOrder].reverse(),
      );
      await p.getByRole("button", { name: "Done", exact: true }).click();
      await admin.call("receivers.reorder", { ids: originalOrder });
      // The editor is accessible directly from the table, including on phones.
      await p
        .getByRole("button", { name: "Edit receiver", exact: true })
        .first()
        .click();
      assert(await p.getByLabel("IP address", { exact: true }).isVisible());
      const advanced = p.locator(".control-dialog .disclosure > summary");
      await advanced.click();
      await advanced.hover();
      const contrast = await advanced.evaluate((el) => {
        const style = getComputedStyle(el);
        const luminance = (color) =>
          color
            .match(/[\d.]+/g)
            .slice(0, 3)
            .map(Number)
            .map((n) => n / 255)
            .map((n) =>
              n <= 0.04045 ? n / 12.92 : ((n + 0.055) / 1.055) ** 2.4,
            )
            .reduce((sum, n, i) => sum + n * [0.2126, 0.7152, 0.0722][i], 0);
        const a = luminance(style.color),
          b = luminance(style.backgroundColor);
        return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
      });
      assert(contrast >= 4.5, "Disclosure hover must keep its label readable");
      assert(await p.getByLabel("API port", { exact: true }).isVisible());
      await p.screenshot({
        path: `${root}/docs/screenshots/${kind}-disclosure-hover.png`,
      });
      await p.keyboard.press("Escape");
      await p
        .getByRole("button", { name: "+ Add device", exact: true })
        .click();
      assert(
        await p
          .getByRole("button", { name: "Discover receivers", exact: true })
          .isVisible(),
      );
      await p.keyboard.press("Escape");
      await p
        .getByRole("button", { name: "+ Add source", exact: true })
        .click();
      await p.getByLabel("Source", { exact: true }).waitFor();
      await p.keyboard.press("Escape");
      await p.getByRole("button", { name: "Auto bugfix", exact: true }).click();
      await p
        .locator('.toast[data-kind="success"]')
        .filter({ hasText: "Auto bugfix complete" })
        .waitFor();
      // Partial failures must be reported; the healthy receiver is still checked.
      await fault({ receiver: 1, online: false });
      await p.getByRole("button", { name: "Auto bugfix", exact: true }).click();
      await p
        .locator('.toast[data-kind="error"]')
        .filter({ hasText: "Some receivers" })
        .waitFor();
      await fault({ receiver: 1, online: true });
      await p.getByRole("button", { name: "Settings", exact: true }).click();
      await p
        .getByRole("button", { name: "Create Simple Mode", exact: true })
        .click();
      const editor = p.locator(".profile-editor");
      assert.equal(
        await editor
          .locator(
            '[name="name"], [name="enabled"], [name="description"], [name="icon"]',
          )
          .count(),
        0,
        "Only a password and button mappings are needed",
      );
      await editor.getByLabel("Password", { exact: true }).fill(password);
      await editor.getByLabel("Name", { exact: true }).fill("Monitor 1");
      await editor.getByRole("button", { name: "Save", exact: true }).click();
      await editor
        .locator('.toast[data-kind="error"]')
        .filter({ hasText: "distinct password" })
        .waitFor();
      assert(await editor.isVisible());
      await editor
        .getByLabel("Password", { exact: true })
        .fill("control-room-9347");
      for (let i = 1; i < 10; i++) {
        await editor
          .getByRole("button", { name: "+ Add button", exact: true })
          .click();
        await editor
          .getByLabel("Name", { exact: true })
          .nth(i)
          .fill(`Monitor ${i + 1}`);
      }
      assert(
        await editor
          .getByRole("button", { name: "+ Add button", exact: true })
          .isDisabled(),
      );
      assert.equal(
        await editor.getByLabel("Device", { exact: true }).count(),
        10,
      );
      assert.equal(
        await editor.getByLabel("NDI source", { exact: true }).count(),
        10,
      );
      await p
        .locator(".toast-close")
        .evaluateAll((buttons) => buttons.forEach((button) => button.click()));
      await p.waitForFunction(() => !document.querySelector(".toast"));
      await editor.locator(".dialog-body").evaluate((el) => (el.scrollTop = 0));
      await p.screenshot({
        path: `${root}/docs/screenshots/${kind}-profile-editor-desktop.png`,
      });
      await p.setViewportSize({ width: 390, height: 844 });
      assert.equal(
        await p.evaluate(
          () => document.documentElement.scrollWidth > innerWidth,
        ),
        false,
      );
      assert.equal(
        await editor.evaluate((el) => el.scrollWidth > el.clientWidth),
        false,
      );
      await editor.locator(".dialog-body").evaluate((el) => (el.scrollTop = 0));
      assert(
        await editor
          .locator(".dialog-footer")
          .evaluate(
            (el) => el.getBoundingClientRect().bottom <= innerHeight - 8,
          ),
        "Save stays inside the viewport",
      );
      await p.screenshot({
        path: `${root}/docs/screenshots/${kind}-profile-editor-mobile.png`,
      });
      await editor.getByRole("button", { name: "Save", exact: true }).click();
      await editor.waitFor({ state: "detached" });
      const profile = (await admin.call("simple.list")).find(
        (x) => x.name === "Monitor 1",
      );
      assert.equal(profile.actions.length, 10);
      await p.keyboard.press("Escape");
      // Log in with the separate profile password and run its real repair flow.
      await p.getByRole("button", { name: "Settings", exact: true }).click();
      await p.getByRole("button", { name: "Disconnect", exact: true }).click();
      if (kind === "remote")
        await p.getByLabel("Device name", { exact: true }).fill(name);
      await p.getByLabel("Password", { exact: true }).fill("control-room-9347");
      await p.getByRole("button", { name: "Connect", exact: true }).click();
      await p
        .getByRole("heading", { name: "Monitor 1", exact: true })
        .waitFor();
      assert.equal(await p.locator(".simple-action").count(), 10);
      await p.getByRole("button", { name: "Monitor 1", exact: true }).click();
      await p
        .locator('.toast[data-kind="success"]')
        .filter({ hasText: "Routing verified" })
        .waitFor();
      await p.getByRole("button", { name: "Auto bugfix", exact: true }).click();
      await p
        .locator('.toast[data-kind="success"]')
        .filter({ hasText: "Auto bugfix complete" })
        .waitFor();
      await p
        .locator(".toast-close")
        .evaluateAll((buttons) => buttons.forEach((button) => button.click()));
      await p.waitForFunction(() => !document.querySelector(".toast"));
      await p.evaluate(() => window.scrollTo(0, 0));
      await p.screenshot({
        path: `${root}/docs/screenshots/${kind}-simple-dark.png`,
        fullPage: true,
      });
      await p.getByRole("button", { name: "Logout", exact: true }).click();
      await change("simple.delete", { id: profile.id });
      if (kind === "remote")
        await p.getByLabel("Device name", { exact: true }).fill(name);
      await p.getByLabel("Password", { exact: true }).fill(password);
      await p.getByRole("button", { name: "Connect", exact: true }).click();
      await p.locator(".crosspoint").first().waitFor();
      for (const width of [320, 390, 768, 1440]) {
        await p.setViewportSize({ width, height: 1000 });
        assert.equal(
          await p.evaluate(
            () => document.documentElement.scrollWidth > innerWidth,
          ),
          false,
        );
      }
      await p.locator("[data-language]").selectOption("hu");
      await p
        .getByRole("heading", { name: "Útválasztás", exact: true })
        .waitFor();
      await p.screenshot({
        path: `${root}/docs/screenshots/${kind}-redesign-desktop.png`,
        fullPage: true,
      });
      await p.setViewportSize({ width: 390, height: 844 });
      await p.screenshot({
        path: `${root}/docs/screenshots/${kind}-redesign-mobile-hu.png`,
        fullPage: true,
      });
      const accessibility = await new AxeBuilder({ page: p })
        .withTags(["wcag2a", "wcag2aa", "wcag21aa"])
        .analyze();
      assert.deepEqual(
        accessibility.violations.map((v) => ({
          id: v.id,
          nodes: v.nodes.map((n) => n.target),
        })),
        [],
        `${kind} accessibility`,
      );
      assert.deepEqual(errors, [], `${kind} runtime errors`);
      await context.close();
    }
    pass(
      "dark single-screen matrix, modal editing, persistent column order, Event Mode, 10-row profile editor, separate-password Simple Mode, real admin/restricted Auto bugfix, partial failures, Hungarian/mobile layout and axe accessibility",
    );
  } catch (error) {
    if (activePage && !activePage.isClosed()) {
      console.error(await activePage.locator("body").innerText());
      await activePage.screenshot({
        path: `${root}/docs/screenshots/redesign-failure.png`,
      });
    }
    throw error;
  } finally {
    await browser.close();
  }
}
