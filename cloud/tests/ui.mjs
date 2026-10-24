import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { chromium } from "@playwright/test";
export async function checkRemoteAccess({ local, password, root }) {
  const browser = await chromium.launch({ headless: true });
  try {
    const p = await browser.newPage({ viewport: { width: 390, height: 844 } });
    const errors = [];
    p.on("pageerror", (error) => errors.push(error.message));
    const connect = async () => {
      await p.getByLabel("Password", { exact: true }).fill(password);
      await p.getByRole("button", { name: "Connect", exact: true }).click();
      await p.locator(".app-shell").waitFor();
    };
    await p.goto(local);
    await connect();
    for (const enabled of [false, true]) {
      await p.getByRole("button", { name: "Settings", exact: true }).click();
      await p
        .getByRole("button", { name: "Remote access", exact: true })
        .click();
      const toggle = p.getByRole("switch", {
        name: "Enable remote access",
        exact: true,
      });
      assert.equal(await toggle.isChecked(), !enabled);
      await toggle.click();
      await p
        .getByRole("heading", { name: "Connect to your DRouter", exact: true })
        .waitFor();
      await p
        .locator('.toast[data-kind="success"]')
        .getByText("Remote access updated. Reconnect to continue.", {
          exact: true,
        })
        .waitFor();
      assert.equal(
        await p
          .getByText("Device unavailable or session expired. Connect again.", {
            exact: true,
          })
          .count(),
        0,
      );
      await connect();
    }
    await p.getByRole("button", { name: "Settings", exact: true }).click();
    await p.getByRole("button", { name: "Remote access", exact: true }).click();
    await p
      .locator("details.settings-card")
      .filter({ has: p.locator("summary", { hasText: "Remote access" }) })
      .getByText("Connected", { exact: true })
      .waitFor({ timeout: 60000 });
    assert.equal(
      await p.evaluate(() => document.documentElement.scrollWidth > innerWidth),
      false,
    );
    await p.screenshot({
      path: `${root}/docs/screenshots/local-remote-access-mobile.png`,
    });
    await p.getByRole("button", { name: "Security", exact: true }).click();
    await p
      .getByText("Sessions last 24 hours; settings access lasts 6 hours", {
        exact: true,
      })
      .waitFor();
    assert.deepEqual(errors, []);
    await p.getByRole("button", { name: "Disconnect", exact: true }).click();
  } finally {
    await browser.close();
  }
}
export async function checkSetup({ local, password, root }) {
  const browser = await chromium.launch({ headless: true });
  try {
    const p = await browser.newPage({ viewport: { width: 375, height: 812 } });
    await p.goto(local);
    await p.getByRole("heading", { name: "Welcome to DRouter" }).waitFor();
    await p.getByRole("button", { name: "Continue", exact: true }).click();
    await p.getByLabel("Device name", { exact: true }).fill("studio-router");
    await p
      .getByLabel("Create administrator password", { exact: true })
      .fill(password);
    assert.equal(
      await p.getByLabel("Provisioning token", { exact: true }).count(),
      0,
    );
    await p.getByRole("button", { name: "Continue", exact: true }).click();
    await p.getByRole("heading", { name: "Connect to your network" }).waitFor();
    await p
      .getByRole("button", { name: "Add Wi-Fi network", exact: true })
      .click();
    await p.getByLabel("Network name", { exact: true }).fill("School-WiFi");
    await p.getByLabel("Wi-Fi password", { exact: true }).fill("wifi-secret-1");
    await p.getByRole("button", { name: "Add network", exact: true }).click();
    await p.getByText("School-WiFi", { exact: true }).waitFor();
    await p.getByRole("button", { name: "Continue", exact: true }).click();
    await p.getByRole("heading", { name: "Access from anywhere" }).waitFor();
    await mkdir(`${root}/docs/screenshots`, { recursive: true });
    await p.screenshot({ path: `${root}/docs/screenshots/setup-mobile.png` });
    await p.getByRole("button", { name: "Finish setup", exact: true }).click();
    await p.getByRole("heading", { name: "Your DRouter is ready" }).waitFor();
    await p.screenshot({
      path: `${root}/docs/screenshots/setup-finished-mobile.png`,
    });
    await p.getByRole("button", { name: "Open DRouter", exact: true }).click();
    await p.getByRole("heading", { name: "Routing", exact: true }).waitFor();
    await p.getByRole("button", { name: "Settings", exact: true }).click();
    await p.getByRole("button", { name: "Disconnect", exact: true }).click();
  } finally {
    await browser.close();
  }
}
export async function checkInterfaces({
  local,
  cloud,
  name,
  password,
  root,
  fault,
}) {
  const browser = await chromium.launch({ headless: true });
  const errors = [];
  try {
    await mkdir(`${root}/docs/screenshots`, { recursive: true });
    for (const [kind, origin] of [
      ["local", local],
      ["remote", cloud],
    ]) {
      const p = await browser.newPage({
        viewport: { width: 1366, height: 900 },
      });
      p.on("pageerror", (e) => errors.push(e.message));
      await p.goto(origin);
      if (kind === "remote")
        await p.getByLabel("Device name", { exact: true }).fill(name);
      await p.getByLabel("Password", { exact: true }).fill(password);
      await p.getByRole("button", { name: "Connect", exact: true }).click();
      await p.locator(".crosspoint").first().waitFor();
      assert.equal(await p.locator(".app-nav,.appearance-toggle").count(), 0);
      assert.equal(
        await p.evaluate(() => document.documentElement.dataset.theme),
        "dark",
      );
      const source =
        kind === "local" ? "Studio (Camera A)" : "Studio (Camera B)";
      const route = p.getByRole("button", {
        name: `Route ${source} to BirdDog 1`,
        exact: true,
      });
      await route.click();
      await p.waitForFunction(
        (label) =>
          document
            .querySelector(`[aria-label="${label}"]`)
            ?.getAttribute("aria-pressed") === "true",
        `Route ${source} to BirdDog 1`,
      );
      await p.waitForFunction(
        () => !document.querySelector(".crosspoint:disabled"),
      );
      await route.focus();
      await p.keyboard.press("ArrowRight");
      assert(await p.locator(".crosspoint:focus").count());
      for (const width of [320, 390, 768, 1366, 1920]) {
        await p.setViewportSize({ width, height: width < 900 ? 844 : 1000 });
        assert.equal(
          await p.evaluate(
            () => document.documentElement.scrollWidth > innerWidth,
          ),
          false,
          `${kind} ${width}px overflow`,
        );
        assert(await p.locator(".matrix-scroll").isVisible());
        await p.screenshot({
          path: `${root}/docs/screenshots/${kind}-routing-${width}.png`,
          fullPage: true,
        });
      }
      await p.setViewportSize({ width: 390, height: 844 });
      assert.equal(await p.locator(".receiver-column:visible").count(), 1);
      assert.equal(
        await p
          .locator(".matrix-scroll")
          .evaluate((el) => el.scrollWidth > el.clientWidth),
        false,
        "Mobile matrix must fit without horizontal scrolling",
      );
      const tabs = p.locator('[data-control="receiver-focus"]');
      assert.equal(await tabs.count(), 2);
      await tabs.nth(1).click();
      await p
        .locator(".receiver-column:visible")
        .getByText("BirdDog 2", { exact: true })
        .waitFor();
      assert.equal(await tabs.nth(1).getAttribute("aria-pressed"), "true");
      const mobileRoute = p.getByRole("button", {
        name: "Route Studio (Camera B) to BirdDog 2",
        exact: true,
      });
      const targetBounds = await mobileRoute.boundingBox();
      const cellBounds = await mobileRoute.locator("..").boundingBox();
      assert(
        targetBounds.width >= cellBounds.width - 3 &&
          targetBounds.height >= 60 &&
          Math.abs(targetBounds.height - cellBounds.height) <= 3,
        "Entire route cell is a usable target",
      );
      await mobileRoute.click();
      await p.waitForFunction(
        () =>
          document
            .querySelector(
              '.route-cell[data-mobile-visible="true"] .crosspoint[data-source="Studio (Camera B)"]',
            )
            ?.getAttribute("aria-pressed") === "true",
      );
      await p.waitForFunction(
        () => !document.querySelector(".crosspoint:disabled"),
      );
      await p
        .getByRole("searchbox", { name: "Find a source", exact: true })
        .fill("no-such-transmitter");
      await p.getByText("No matching sources", { exact: true }).waitFor();
      await p
        .getByRole("searchbox", { name: "Find a source", exact: true })
        .fill("");
      assert.equal(
        await tabs.nth(1).getAttribute("aria-pressed"),
        "true",
        "Receiver choice survives filtering",
      );
      await tabs.first().click();
      // A long alias can make a source row taller: the route target must still fill it.
      const renameFirstSource = async (label) => {
        await p
          .getByRole("button", { name: "Edit source", exact: true })
          .first()
          .click();
        await p.getByLabel("Display name", { exact: true }).fill(label);
        await p
          .getByRole("dialog")
          .getByRole("button", { name: "Save", exact: true })
          .click();
        await p.getByRole("dialog").waitFor({ state: "detached" });
      };
      await renameFirstSource("W".repeat(64));
      const tallCell = p
        .locator(".source-row")
        .first()
        .locator('.route-cell[data-mobile-visible="true"]');
      const tallBounds = await tallCell.boundingBox();
      const tallTarget = await tallCell.locator(".crosspoint").boundingBox();
      assert(
        Math.abs(tallBounds.height - tallTarget.height) <= 3,
        "Long-name rows retain a full-height route target",
      );
      assert.equal(
        await p
          .locator(".matrix-scroll")
          .evaluate((el) => el.scrollWidth > el.clientWidth),
        false,
      );
      await renameFirstSource("Studio (Camera A)");

      const otherRow = p.locator(".route-table tbody tr").last();
      assert.equal(
        await otherRow.getByRole("rowheader").locator("strong").innerText(),
        "Other device",
      );
      assert.equal(
        await p.getByRole("button", { name: /Add row|Add column/ }).count(),
        0,
      );
      assert(
        await p
          .getByRole("button", { name: "+ Add source", exact: true })
          .isVisible(),
      );
      assert(
        await p
          .getByRole("button", { name: "+ Add device", exact: true })
          .isVisible(),
      );
      const chooser = otherRow.locator('td[data-mobile-visible="true"] select');
      assert.deepEqual(
        await chooser
          .locator('option:not([value=""])')
          .evaluateAll((options) =>
            options.map((option) => option.value).sort(),
          ),
        ["Graphics (Program)", "Studio (Camera A)", "Studio (Camera B)"].sort(),
      );
      await chooser.selectOption("Studio (Camera A)");
      await p.waitForFunction(
        () =>
          document
            .querySelector(
              '.route-cell[data-mobile-visible="true"] .crosspoint[data-source="Studio (Camera A)"]',
            )
            ?.getAttribute("aria-pressed") === "true",
      );
      await p.waitForFunction(
        () => !document.querySelector(".crosspoint:disabled"),
      );
      assert.equal(
        await p.getByRole("dialog").count(),
        0,
        "Source selection uses the dropdown directly",
      );
      await tabs.nth(1).click();
      await p.getByRole("button", { name: "Settings", exact: true }).click();
      await p.getByRole("button", { name: "Network", exact: true }).click();
      await p
        .getByRole("button", {
          name: kind === "local" ? "Add network" : "Add network",
          exact: true,
        })
        .click();
      await p.locator("dialog[open]").last().waitFor();
      await p.keyboard.press("Escape");
      assert.equal(await p.locator("dialog[open]").count(), 1);
      await p.keyboard.press("Escape");
      await p.locator("dialog[open]").waitFor({ state: "detached" });
      await p
        .locator(".receiver-column:visible")
        .getByText("BirdDog 2", { exact: true })
        .waitFor();
      assert.equal(
        await p
          .locator('[data-control="receiver-focus"]')
          .nth(1)
          .getAttribute("aria-pressed"),
        "true",
        "Receiver choice survives opening settings",
      );

      await p.close();
    }
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
  }
}
