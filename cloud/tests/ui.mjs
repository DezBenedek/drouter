import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { chromium } from "@playwright/test";
export async function checkInterfaces({ local, cloud, name, password, root }) {
  const browser = await chromium.launch({ headless: true });
  const errors = [];
  const context = await browser.newContext({
    viewport: { width: 1440, height: 1000 },
  });
  const localPage = await context.newPage();
  localPage.on("pageerror", (e) => errors.push(e.message));
  try {
    await mkdir(`${root}/docs/screenshots`, { recursive: true });
    await localPage.goto(local);
    await localPage
      .getByLabel("Administrator password", { exact: true })
      .fill(password);
    await localPage
      .getByRole("button", { name: "Connect →", exact: true })
      .click();
    await localPage
      .getByRole("heading", { name: "Dashboard", exact: true })
      .waitFor();
    await localPage
      .getByRole("button", { name: "Routing", exact: true })
      .click();
    await localPage
      .getByRole("button", {
        name: "Route Studio (Camera A) to BirdDog 1",
        exact: true,
      })
      .click();
    await localPage
      .getByRole("button", {
        name: "Route Studio (Camera A) to BirdDog 1",
        exact: true,
      })
      .filter({ hasText: "✓" })
      .waitFor();
    await localPage.screenshot({
      path: `${root}/docs/screenshots/local-routing.png`,
      fullPage: true,
    });
    const remote = await context.newPage();
    remote.on("pageerror", (e) => errors.push(e.message));
    await remote.goto(cloud);
    await remote.getByLabel("DRouter remote name").fill(name);
    await remote.getByLabel("Device password", { exact: true }).fill(password);
    await remote.getByRole("button", { name: "Connect", exact: true }).click();
    await remote
      .getByRole("heading", { name: "Dashboard", exact: true })
      .waitFor();
    await remote.getByRole("button", { name: "Routing", exact: true }).click();
    await remote
      .getByRole("button", {
        name: "Route Studio (Camera B) to BirdDog 1",
        exact: true,
      })
      .click();
    await remote
      .getByRole("button", {
        name: "Route Studio (Camera B) to BirdDog 1",
        exact: true,
      })
      .filter({ hasText: "✓" })
      .waitFor();
    await remote.screenshot({
      path: `${root}/docs/screenshots/remote-routing.png`,
      fullPage: true,
    });
    await remote.setViewportSize({ width: 390, height: 844 });
    await remote.screenshot({
      path: `${root}/docs/screenshots/remote-mobile.png`,
      fullPage: true,
    });
    assert.equal(
      await remote.evaluate(
        () => document.documentElement.scrollWidth > innerWidth,
      ),
      false,
      "Mobile layout overflows viewport",
    );
    assert.deepEqual(errors, [], "Browser runtime errors");
  } finally {
    await browser.close();
  }
}
