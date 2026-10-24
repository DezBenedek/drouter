import assert from "node:assert/strict";
import { chromium } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

async function settleToast(locator) {
  await locator.evaluate(async (el) => {
    const root = el.closest("[data-sonner-toast]") || el;
    await new Promise((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(resolve)),
    );
    await Promise.all(
      root
        .getAnimations({ subtree: true })
        .map((animation) => animation.finished),
    );
  });
}

// Real simulator + relay browser acceptance for the redesigned workflows.
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
  try {
    for (const [kind, origin] of [
      ["local", local],
      ["remote", cloud],
    ]) {
      const context = await browser.newContext({
        viewport: { width: 1440, height: 1000 },
      });
      const p = await context.newPage();
      const errors = [];
      p.on("pageerror", (e) => errors.push(e.message));
      p.on("console", (m) => {
        if (m.type() === "error" && !m.text().includes("status of 404"))
          errors.push(m.text());
      });
      await p.goto(origin);
      if (kind === "remote")
        await p.getByLabel("Device name", { exact: true }).fill(name);
      await p.getByLabel("Password", { exact: true }).fill(password);
      await p.getByRole("button", { name: "Connect", exact: true }).click();
      await p.getByRole("heading", { name: "Routing", exact: true }).waitFor();
      const eventSwitch = p.getByRole("switch", {
        name: "Event Mode",
        exact: true,
      });
      const transition = async (enabled) => {
        const before = (await admin.call("event.status")).enabled;
        if (before === enabled) return;
        await eventSwitch.click();
        await p.getByRole("dialog").waitFor();
        assert.equal(await p.getByRole("dialog").count(), 1);
        assert.equal((await admin.call("event.status")).enabled, before);
        await p
          .getByRole("dialog")
          .getByRole("button", { name: "Confirm", exact: true })
          .click();
        await p.getByRole("dialog").waitFor({ state: "detached" });
        await p.waitForFunction(
          (value) =>
            document
              .querySelector(".event-toggle")
              ?.getAttribute("aria-checked") === String(value),
          enabled,
        );
        assert.equal((await admin.call("event.status")).enabled, enabled);
      };
      await transition(false);
      await eventSwitch.click();
      await p
        .getByRole("dialog")
        .getByRole("button", { name: "Cancel", exact: true })
        .click();
      assert.equal((await admin.call("event.status")).enabled, false);
      await p.locator(".crosspoint").first().click();
      const desktopToast = p
        .locator('.toast[data-kind="success"]')
        .filter({ hasText: "Routing verified" });
      await desktopToast.waitFor();
      await settleToast(desktopToast);
      const desktopBox = await desktopToast.boundingBox();
      assert(Math.abs(desktopBox.x - 24) <= 1);
      assert(
        Math.abs(1000 - desktopBox.y - desktopBox.height - 24) <= 1,
        `${kind} toast placement: ${JSON.stringify(desktopBox)}`,
      );
      await p.screenshot({
        path: `${root}/docs/screenshots/${kind}-toast-desktop.png`,
      });
      await desktopToast
        .getByRole("button", { name: "Dismiss notification", exact: true })
        .click();
      await desktopToast.waitFor({ state: "detached" });
      const access = await new AxeBuilder({ page: p })
        .withTags(["wcag2a", "wcag2aa", "wcag21aa"])
        .analyze();
      assert.deepEqual(
        access.violations.map((v) => ({
          id: v.id,
          nodes: v.nodes.map((n) => n.target),
        })),
        [],
        `${kind} desktop routing accessibility`,
      );
      await p.screenshot({
        path: `${root}/docs/screenshots/${kind}-redesign-desktop.png`,
        fullPage: true,
      });
      for (const page of [
        "Sources",
        "Devices",
        "Presets",
        "Simple Modes",
        "Settings",
      ]) {
        await p.getByRole("button", { name: page, exact: true }).click();
        assert(
          await eventSwitch.isVisible(),
          `${page} has header access to Event Mode`,
        );
        if (page === "Sources")
          await p.locator("[data-control=source-add]").waitFor();
        if (page === "Simple Modes")
          await p.locator("[data-control=profile-add]").waitFor();
        await p.screenshot({
          path: `${root}/docs/screenshots/${kind}-${page.toLowerCase().replaceAll(" ", "-")}-desktop.png`,
          fullPage: true,
        });
      }
      // Direct inline rename saves without a confirmation dialog and preserves source identity.
      await p.getByRole("button", { name: "Sources", exact: true }).click();
      const original = (await admin.call("sources.saved.list"))[0];
      await p
        .getByRole("button", { name: "Rename", exact: true })
        .first()
        .click();
      await p
        .getByLabel("Display name", { exact: true })
        .fill("Temporary alias");
      await p
        .locator(".inline-editor")
        .getByRole("button", { name: "Save", exact: true })
        .click();
      await p.getByText("Temporary alias", { exact: true }).waitFor();
      assert.equal(await p.getByRole("dialog").count(), 0);
      let saved = (await admin.call("sources.saved.list")).find(
        (s) => s.id === original.id,
      );
      assert.equal(saved.source, original.source);
      assert.equal(saved.display_name, "Temporary alias");
      await p
        .getByRole("button", { name: "Rename", exact: true })
        .first()
        .click();
      await p
        .getByLabel("Display name", { exact: true })
        .fill(original.display_name);
      await p
        .locator(".inline-editor")
        .getByRole("button", { name: "Save", exact: true })
        .click();
      await p
        .getByText(original.display_name, { exact: true })
        .first()
        .waitFor();
      // Numbered profile actions, limit, keyboard controls and save are one workflow.
      await p
        .getByRole("button", { name: "Simple Modes", exact: true })
        .click();
      await p
        .getByRole("button", { name: "Create Simple Mode", exact: true })
        .click();
      const editor = p.getByRole("dialog");
      await editor
        .getByLabel("Profile name", { exact: true })
        .fill("Control room");
      await editor.getByLabel("Password", { exact: true }).fill(password);
      await editor.getByLabel("Label", { exact: true }).fill("Monitor 1");
      await editor.getByRole("button", { name: "Save", exact: true }).click();
      const formToast = editor.locator('.toast[data-kind="error"]');
      await formToast.waitFor();
      assert(await editor.isVisible(), "Failed form stays open");
      assert(
        await editor
          .locator(".toast-region, .feedback-layer")
          .evaluate((el) => el.matches(":popover-open")),
        "Modal errors appear in the top layer",
      );
      await p.screenshot({
        path: `${root}/docs/screenshots/${kind}-toast-dialog.png`,
      });
      await formToast
        .getByRole("button", { name: "Dismiss notification", exact: true })
        .click();
      await formToast.waitFor({ state: "detached" });
      await editor
        .getByLabel("Password", { exact: true })
        .fill("control-room-9347");
      for (let i = 0; i < 10; i++) {
        if (i)
          await editor
            .getByRole("button", { name: "Add button", exact: true })
            .click();
        await editor
          .getByLabel("Label", { exact: true })
          .nth(i)
          .fill(`Monitor ${i + 1}`);
      }
      assert(
        await editor
          .getByRole("button", { name: "Add button", exact: true })
          .isDisabled(),
      );
      await p.screenshot({
        path: `${root}/docs/screenshots/${kind}-profile-editor-desktop.png`,
        fullPage: true,
      });
      await p.setViewportSize({ width: 390, height: 844 });
      assert.equal(
        await p.evaluate(
          () => document.documentElement.scrollWidth > innerWidth,
        ),
        false,
      );
      await p.screenshot({
        path: `${root}/docs/screenshots/${kind}-profile-editor-mobile.png`,
        fullPage: true,
      });
      await editor.getByRole("button", { name: "Save", exact: true }).click();
      await editor.waitFor({ state: "detached" });
      const profile = (await admin.call("simple.list")).find(
        (x) => x.name === "Control room",
      );
      assert.equal(profile.actions.length, 10);
      await p.setViewportSize({ width: 1440, height: 1000 });
      const row = p.locator(".list-row").filter({ hasText: "Control room" });
      await row.getByRole("button", { name: "Delete", exact: true }).click();
      await p
        .getByRole("dialog")
        .getByRole("button", { name: "Confirm", exact: true })
        .click();
      await p.getByRole("dialog").waitFor({ state: "detached" });
      // Small-screen navigation and one-touch saved sources.
      await p.getByRole("button", { name: "Routing", exact: true }).click();
      for (const width of [320, 390, 768, 899, 900, 1024]) {
        await p.setViewportSize({ width, height: 844 });
        assert.equal(
          await p.evaluate(
            () => document.documentElement.scrollWidth > innerWidth,
          ),
          false,
          `${kind} ${width}px overflow`,
        );
        assert(await eventSwitch.isVisible());
      }
      await p.setViewportSize({ width: 390, height: 844 });
      // Mobile overflow is dismissible without selecting a destination.
      const more = p.getByRole("button", { name: "More", exact: true });
      await more.click();
      await p.locator(".more-menu").waitFor({ state: "visible" });
      await p.keyboard.press("Escape");
      assert.equal(await more.getAttribute("aria-expanded"), "false");
      await more.click();
      await p.locator(".more-backdrop").click({ position: { x: 8, y: 8 } });
      assert.equal(await more.getAttribute("aria-expanded"), "false");
      assert.equal(await p.locator(".more-menu").isVisible(), false);
      if (kind === "remote")
        assert.equal(
          await p
            .locator(".feedback-layer > section[data-react-aria-top-layer]")
            .count(),
          1,
        );
      const outputSearch = p.getByRole("searchbox", {
        name: "Find an output",
        exact: true,
      });
      await outputSearch.fill("no-such-output");
      await p
        .getByRole("heading", { name: "No matching outputs", exact: true })
        .waitFor();
      await outputSearch.fill("");
      const receiver = (await admin.call("receivers.list"))[0];
      const choices = await admin.call("sources.saved.list");
      const target = choices.find((s) => s.source !== receiver.state.source);
      const quick = p
        .locator(".output-row")
        .first()
        .getByRole("button", {
          name: `Route ${target.display_name} to ${receiver.config.label}`,
          exact: true,
        });
      await fault({ receiver: 0, delay_ms: 1000 });
      await quick.click();
      assert.equal(
        await quick.getAttribute("aria-pressed"),
        "false",
        "Pending is never shown as verified",
      );
      await p.waitForFunction(
        () => !document.querySelector(".quick-route:disabled"),
        null,
        { timeout: 20000 },
      );
      assert.equal(await quick.getAttribute("aria-pressed"), "true");
      const mobileToast = p
        .locator('.toast[data-kind="success"]')
        .filter({ hasText: "Routing verified" });
      await mobileToast.waitFor();
      await settleToast(mobileToast);
      const toastBox = await mobileToast.boundingBox(),
        navBox = await p.locator(".app-nav").boundingBox();
      assert(
        toastBox.y + toastBox.height <= navBox.y - 8,
        "Toast clears mobile navigation",
      );
      assert(
        navBox.y - toastBox.y - toastBox.height < 30,
        "Toast sits directly above navigation",
      );
      assert(
        toastBox.x >= 12 && toastBox.x + toastBox.width <= 378,
        "Mobile toast fits screen",
      );
      await p.screenshot({
        path: `${root}/docs/screenshots/${kind}-toast-mobile.png`,
      });
      await p.mouse.move(0, 0);
      await mobileToast.waitFor({ state: "detached", timeout: 8000 });

      await fault({ receiver: 0, delay_ms: 0, ignore_switch: true });
      const failedChoice = choices.find((s) => s.source !== target.source);
      const failButton = p
        .locator(".output-row")
        .first()
        .getByRole("button", {
          name: `Route ${failedChoice.display_name} to ${receiver.config.label}`,
          exact: true,
        });
      await failButton.click();
      await p.locator('.toast[data-kind="error"]').waitFor({ timeout: 15000 });
      assert.equal(await failButton.getAttribute("aria-pressed"), "false");
      await fault({ receiver: 0, ignore_switch: false });
      await p.getByRole("button", { name: "More", exact: true }).click();
      await p
        .locator(".more-menu")
        .getByRole("button", { name: "Devices", exact: true })
        .click();
      await p.getByRole("heading", { name: "Devices", exact: true }).waitFor();
      assert.equal(await p.locator(".more-menu").isVisible(), false);
      await transition(true);
      await transition(false);
      await p.getByRole("button", { name: "Routing", exact: true }).click();
      await p.locator(".output-open").first().waitFor();
      await p.screenshot({
        path: `${root}/docs/screenshots/${kind}-redesign-mobile.png`,
        fullPage: true,
      });
      const mobileAccess = await new AxeBuilder({ page: p })
        .withTags(["wcag2a", "wcag2aa", "wcag21aa"])
        .analyze();
      assert.deepEqual(
        mobileAccess.violations.map((v) => ({
          id: v.id,
          nodes: v.nodes.map((n) => n.target),
        })),
        [],
        `${kind} mobile routing accessibility`,
      );
      await p.getByRole("button", { name: "More", exact: true }).click();
      await p.locator(".more-menu [data-language]").selectOption("hu");
      if (kind === "remote")
        assert.equal(
          await p.locator(".topbar-actions .appearance-toggle").isVisible(),
          false,
        );
      await p
        .getByRole("heading", { name: "Útválasztás", exact: true })
        .waitFor();
      await p.getByRole("button", { name: "Továbbiak", exact: true }).click();
      await p.screenshot({
        path: `${root}/docs/screenshots/${kind}-redesign-mobile-hu.png`,
        fullPage: true,
      });
      assert.equal(
        await p.evaluate(
          () => document.documentElement.scrollWidth > innerWidth,
        ),
        false,
      );
      assert.deepEqual(errors, [], `${kind} runtime/CSP errors`);
      await context.close();
    }
    pass(
      "redesign: header Event Mode with one confirmation, inline rename, 10-action profile editor, native mobile navigation, confirmed/failed quick routes, Hungarian layout, desktop/mobile/modal toast placement, dismissal/expiry, and axe accessibility",
    );
  } finally {
    await browser.close();
  }
}
