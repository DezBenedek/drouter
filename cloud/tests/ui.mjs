import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { chromium } from "@playwright/test";
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
  const context = await browser.newContext({
    viewport: { width: 1366, height: 900 },
  });
  const pages = [];
  const capture = async (p, file) => {
    assert.equal(
      await p.evaluate(() => document.documentElement.scrollWidth > innerWidth),
      false,
      "Page overflows",
    );
    await p.screenshot({
      path: `${root}/docs/screenshots/${file}.png`,
      fullPage: true,
      animations: "disabled",
    });
  };
  try {
    await mkdir(`${root}/docs/screenshots`, { recursive: true });
    for (const kind of ["local", "remote"]) {
      const p = await context.newPage();
      pages.push(p);
      p.on("pageerror", (e) => errors.push(e.message));
      p.on("console", (m) => {
        if (m.type() === "error" && !m.text().includes("status of 404"))
          errors.push(m.text());
      });
      await p.goto(kind === "local" ? local : cloud);
      await capture(p, `${kind}-login`);
      if (kind === "remote")
        await p.getByLabel("Device name", { exact: true }).fill(name);
      await p
        .getByLabel("Password", {
          exact: true,
        })
        .fill(password);
      await p.getByRole("button", { name: "Connect", exact: true }).click();
      await p.getByRole("heading", { name: "Routing", exact: true }).waitFor();
      const source =
          kind === "local" ? "Studio (Camera A)" : "Studio (Camera B)",
        route = p.getByRole("button", {
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
      await capture(p, `${kind}-routing`);
      await route.focus();
      await p.keyboard.press("ArrowRight");
      assert(await p.locator(".crosspoint:focus").count());
      for (const width of [375, 430, 768, 1366, 1920]) {
        await p.setViewportSize({ width, height: width < 900 ? 844 : 1000 });
        await capture(p, `${kind}-${width}`);
        if (width < 900) {
          assert.equal(await p.locator(".matrix-scroll").isVisible(), false);
          await p
            .getByRole("button", {
              name: "Change source for BirdDog 1",
              exact: true,
            })
            .click();
          const input = p.getByRole("dialog").getByRole("searchbox");
          await input.fill("Camera A");
          assert.equal(await p.locator(".source-option:visible").count(), 1);
          await capture(p, `${kind}-picker-${width}`);
          await p.keyboard.press("Escape");
          await p.getByRole("dialog").waitFor({ state: "detached" });
        }
      }
      await p.setViewportSize({ width: 375, height: 844 });
      await p
        .getByRole("button", {
          name: "Change source for BirdDog 1",
          exact: true,
        })
        .click();
      await p
        .getByRole("dialog")
        .getByRole("button", { name: "Studio (Camera A)", exact: true })
        .click();
      await p.waitForFunction(
        () => !document.querySelector(".output-open:disabled"),
      );
      await p.getByRole("button", { name: "Settings", exact: true }).click();
      await p.getByRole("button", { name: "Wi-Fi", exact: true }).click();
      await capture(p, `${kind}-wifi-mobile`);
      await p.getByRole("button", { name: "Add network", exact: true }).click();
      await p.getByRole("dialog").waitFor();
      await p.keyboard.press("Escape");
      await p.getByRole("dialog").waitFor({ state: "detached" });
      await p
        .getByRole("button", { name: "Change appearance", exact: true })
        .click();
      await capture(p, `${kind}-dark-mobile`);
      await p
        .getByRole("button", { name: "Change appearance", exact: true })
        .click();
      await p.getByRole("button", { name: "Presets", exact: true }).click();
      await p.getByRole("button", { name: "Apply", exact: true }).click();
      await p
        .getByRole("dialog")
        .getByRole("heading", { name: "Apply Opening?" })
        .waitFor();
      await capture(p, `${kind}-preset-mobile`);
      await p.keyboard.press("Escape");
      await p.getByRole("button", { name: "Routing", exact: true }).click();
      await p.setViewportSize({ width: 1366, height: 900 });
    }
    const large = Array.from(
      { length: 64 },
      (_, i) => `Stage ${String(i + 1).padStart(2, "0")} (Camera feed)`,
    );
    await fault({ receiver: 0, sources: large });
    await fault({ receiver: 1, sources: large });
    for (let i = 0; i < pages.length; i++) {
      const p = pages[i],
        kind = i ? "remote" : "local";
      await p.getByRole("button", { name: "Refresh sources" }).click();
      assert.equal(await p.locator(".route-table thead th").count(), 3);
      await capture(p, `${kind}-large-matrix`);
      await p.setViewportSize({ width: 375, height: 844 });
      await p
        .getByRole("button", { name: "Change source for BirdDog 1" })
        .click();
      await p
        .getByRole("dialog")
        .getByRole("button", { name: "All Sources", exact: true })
        .click();
      await p.getByRole("dialog").getByRole("searchbox").fill("Stage 64");
      await p
        .getByRole("dialog")
        .getByRole("button", { name: large[63], exact: true })
        .click();
      await p.waitForFunction(
        () => !document.querySelector(".output-open:disabled"),
      );
      await capture(p, `${kind}-large-mobile`);
    }
    await fault({
      receiver: 0,
      sources: ["Studio (Camera A)", "Studio (Camera B)", "Graphics (Program)"],
    });
    await fault({
      receiver: 1,
      sources: ["Studio (Camera A)", "Studio (Camera B)", "Graphics (Program)"],
    });
    assert.deepEqual(errors, [], "Browser runtime or CSP errors");
  } finally {
    await browser.close();
  }
}
