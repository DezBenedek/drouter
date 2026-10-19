import assert from "node:assert/strict";
import { chromium } from "@playwright/test";
import { Client } from "../../firmware/web/shared/client.js";
import { dictionaries } from "../../firmware/web/shared/i18n.js";
export async function modification3({
  admin,
  local,
  cloud,
  name,
  password,
  receivers,
  fault,
  pass,
  root,
}) {
  const change = async (op, params = {}) =>
    admin.call(op, {
      ...params,
      confirmed: true,
      expected_revision: (await admin.call("device.info")).revision,
    });
  const [first, second] = receivers;
  const sourceA = "Studio (Camera A)",
    sourceB = "Studio (Camera B)",
    other = "Graphics (Program)";
  let saved = await admin.call("sources.saved.list");
  await assert.rejects(
    admin.call("sources.saved.remove", {
      id: saved[0].id,
      confirmed: false,
      expected_revision: (await admin.call("device.info")).revision,
    }),
  );
  assert.deepEqual(await admin.call("sources.saved.list"), saved);
  await change("sources.saved.update", {
    id: saved[0].id,
    display_name: "Teacher PC",
  });
  await change("sources.saved.reorder", {
    ids: saved.map((s) => s.id).reverse(),
  });
  assert.equal(
    (await admin.call("sources.saved.list"))[1].display_name,
    "Teacher PC",
  );
  await change("sources.saved.remove", { id: saved[1].id });
  assert.equal((await admin.call("sources.saved.list")).length, 1);
  await change("sources.saved.add", {
    source: sourceB,
    display_name: "Camera",
  });
  pass(
    "saved source aliases, reorder, confirmed deletion, cancellation, and original identifiers",
  );
  const action = (id, receiver, source, label) => ({
    id,
    label,
    icon: null,
    receiver: receiver.id,
    source,
    enabled: true,
    order: 0,
  });
  await change("simple.create", {
    name: "Classroom",
    password: "1234",
    description: "Teaching controls",
    actions: [action("teacher", first, sourceB, "Projector – Camera")],
  });
  await change("simple.create", {
    name: "Stage",
    password: "5678",
    actions: [action("stage", second, sourceA, "Stage – Teacher")],
  });
  await assert.rejects(
    change("simple.create", {
      name: "Duplicate",
      password: "1234",
      actions: [action("invalid", first, sourceA, "Duplicate")],
    }),
    /distinct password/,
  );
  await assert.rejects(
    change("simple.update", {
      id: (await admin.call("simple.list"))[0].id,
      password,
    }),
    /distinct password/,
  );
  assert(!JSON.stringify(await admin.call("simple.list")).includes("verifier"));
  const classroom = await new Client().open("", "1234", false);
  let stage = await new Client().open(name, "5678");
  assert.equal((await classroom.call("auth.session")).role, "simple_mode");
  assert.equal((await classroom.call("simple.actions.list")).name, "Classroom");
  assert.equal((await stage.call("simple.actions.list")).name, "Stage");
  for (const op of [
    "device.info",
    "wifi.list",
    "settings.update",
    "sources.saved.add",
    "simple.list",
    "route.set",
    "event.disable",
  ])
    await assert.rejects(stage.call(op, {}), /Administrator/);
  await assert.rejects(
    stage.call("simple.action.execute", { id: "teacher" }),
    /Unknown action/,
  );
  await assert.rejects(
    stage.call("simple.action.execute", {
      id: "stage",
      source: sourceB,
      receiver: first.id,
    }),
    /unknown field/,
  );
  assert.equal(
    (await stage.call("simple.action.execute", { id: "stage" })).source,
    sourceA,
  );
  await assert.rejects(
    stage.call("simple.action.execute", { id: "stage" }),
    /Wait before repeating/,
  );
  assert.equal(
    (await classroom.call("simple.action.execute", { id: "teacher" })).source,
    sourceB,
  );
  pass(
    "distinct four-character profile passwords authenticate locally and through Cloudflare; fixed actions reject overrides, foreign IDs, admin APIs, and double taps",
  );
  const browser = await chromium.launch({ headless: true });
  try {
    for (const [origin, remote] of [
      [local, false],
      [cloud, true],
    ]) {
      const p = await browser.newPage({
        viewport: { width: 375, height: 844 },
      });
      const errors = [];
      p.on("pageerror", (error) => errors.push(error.message));
      await p.goto(origin);
      await p.locator("[data-language]").selectOption("hu");
      await p
        .getByRole("heading", { name: "Csatlakozás a DRouterhöz" })
        .waitFor();
      await p.reload();
      await p
        .getByRole("heading", { name: "Csatlakozás a DRouterhöz" })
        .waitFor();
      if (remote) await p.getByLabel("Eszköznév", { exact: true }).fill(name);
      await p.getByLabel("Jelszó", { exact: true }).fill("1234");
      await p.getByRole("button", { name: "Csatlakozás", exact: true }).click();
      await p
        .getByRole("heading", { name: "Classroom", exact: true })
        .waitFor();
      assert.equal(await p.locator(".app-nav").count(), 0);
      assert.equal(await p.locator("select:not([data-language])").count(), 0);
      assert.equal(
        await p.evaluate(
          () => document.documentElement.scrollWidth > innerWidth,
        ),
        false,
      );
      await p.waitForTimeout(2100);
      await p
        .getByRole("button", { name: "Projector – Camera", exact: true })
        .click();
      await p
        .getByRole("status")
        .filter({ hasText: "Az átkapcsolás visszaigazolva" })
        .waitFor();
      await p.screenshot({
        animations: "disabled",
        path: `${root}/docs/screenshots/${remote ? "remote" : "local"}-simple-hu.png`,
      });
      await p.locator("[data-language]").selectOption("en");
      await p.getByRole("button", { name: "Logout", exact: true }).waitFor();
      await p.getByRole("button", { name: "Logout", exact: true }).click();
      assert.deepEqual(errors, []);
      await p.close();
    }
    const p = await browser.newPage({ viewport: { width: 1366, height: 900 } });
    await p.goto(local);
    await p.getByLabel("Password", { exact: true }).fill(password);
    await p.getByRole("button", { name: "Connect", exact: true }).click();
    await p.getByRole("button", { name: "Sources", exact: true }).click();
    await p
      .getByRole("button", { name: "Rename", exact: true })
      .first()
      .click();
    await p.getByLabel("Display name", { exact: true }).fill("Cancelled alias");
    await p
      .getByRole("dialog")
      .getByRole("button", { name: "Save", exact: true })
      .click();
    await p
      .getByRole("dialog")
      .filter({ hasText: "Confirm changes" })
      .getByRole("button", { name: "Cancel", exact: true })
      .click();
    assert(
      !(await admin.call("sources.saved.list")).some(
        (s) => s.display_name === "Cancelled alias",
      ),
    );
    await p
      .getByRole("dialog")
      .filter({ hasText: "Confirm changes" })
      .waitFor({ state: "detached" });
    await p
      .getByRole("dialog")
      .getByRole("button", { name: "Cancel", exact: true })
      .click();
    await p
      .waitForFunction(
        () => document.querySelectorAll("dialog[open]").length === 0,
      )
      .catch(async (error) => {
        console.error(await p.locator("body").innerText());
        throw error;
      });
    p.on("pageerror", (error) =>
      console.error("Administrator browser:", error.message),
    );
    await p.getByRole("button", { name: "Routing", exact: true }).click();
    await p.locator(".other-source [data-control=pick]").first().waitFor();
    await p.locator(".other-source [data-control=pick]").first().click();
    await p.getByRole("dialog").getByRole("searchbox").fill("Graphics");
    await p
      .getByRole("dialog")
      .getByRole("button", { name: other, exact: true })
      .click();
    await p
      .getByRole("status")
      .filter({ hasText: "Routing verified" })
      .waitFor({ timeout: 15000 })
      .catch(async (error) => {
        console.error(await p.locator("body").innerText());
        throw error;
      });
    await p.locator(".other-source [data-control=pick]").nth(1).click();
    await p.getByRole("dialog").getByRole("searchbox").fill("Teacher PC");
    await p
      .getByRole("dialog")
      .getByRole("button", { name: "Teacher PC", exact: true })
      .click();
    await p
      .getByRole("status")
      .filter({ hasText: "Routing verified" })
      .waitFor({ timeout: 15000 })
      .catch(async (error) => {
        console.error(await p.locator("body").innerText());
        throw error;
      });
    const independent = await admin.call("route.get");
    assert.equal(independent[0].source, other);
    assert.equal(independent[1].source, sourceA);
    assert.equal(await p.locator(".other-source .other-active").count(), 1);
    assert.equal((await admin.call("sources.saved.list")).length, 2);
    await p.getByRole("button", { name: "Simple Modes", exact: true }).click();
    await p
      .getByRole("button", { name: "Create Simple Mode", exact: true })
      .click();
    const editor = p.getByRole("dialog");
    await editor
      .getByLabel("Profile name", { exact: true })
      .fill("Temporary profile");
    await editor.getByLabel("Password", { exact: true }).fill("rövi");
    await editor.getByLabel("Label", { exact: true }).fill("Teacher");
    await editor
      .getByRole("button", { name: "Add button", exact: true })
      .click();
    await editor.getByLabel("Label", { exact: true }).nth(1).fill("Camera");
    await editor.getByRole("button", { name: "Save", exact: true }).click();
    const confirmation = p
      .getByRole("dialog")
      .filter({ hasText: "Confirm changes" });
    await confirmation
      .getByRole("button", { name: "Confirm", exact: true })
      .click();
    await p
      .waitForFunction(
        () => document.querySelectorAll("dialog[open]").length === 0,
      )
      .catch(async (error) => {
        console.error(await p.locator("body").innerText());
        throw error;
      });
    let temporary = (await admin.call("simple.list")).find(
      (p) => p.name === "Temporary profile",
    );
    assert.equal(temporary.actions.length, 2);
    const profileRow = p
      .locator(".list-row")
      .filter({ hasText: "Temporary profile" });
    await profileRow
      .getByRole("button", { name: "Disable", exact: true })
      .click();
    await p
      .getByRole("dialog")
      .getByRole("button", { name: "Cancel", exact: true })
      .click();
    assert.equal(
      (await admin.call("simple.list")).find((p) => p.id === temporary.id)
        .enabled,
      true,
    );
    await profileRow
      .getByRole("button", { name: "Delete", exact: true })
      .click();
    await p
      .getByRole("dialog")
      .getByRole("button", { name: "Confirm", exact: true })
      .click();
    await p
      .waitForFunction(
        () => document.querySelectorAll("dialog[open]").length === 0,
      )
      .catch(async (error) => {
        console.error(await p.locator("body").innerText());
        throw error;
      });
    assert.equal((await admin.call("simple.list")).length, 2);
    pass(
      "independent searchable Other source selectors route original identifiers without saving; profile editor creates multiple buttons and confirms configuration",
    );
    await p.getByRole("button", { name: "Settings", exact: true }).click();
    await p
      .getByRole("button", { name: "Access Control", exact: true })
      .click();
    await p.locator('a[href="mailto:benedek@dezso.hu"]').waitFor();
    assert.equal(
      await p.locator('a[href="mailto:benedek@dezso.hu"]').count(),
      1,
    );
    await p.locator("[data-language]").first().selectOption("hu");
    await p.getByText("Kapcsolat", { exact: true }).waitFor();
    await p.screenshot({
      animations: "disabled",
      path: `${root}/docs/screenshots/access-control-hu.png`,
    });
    await p.locator("[data-language]").first().selectOption("en");
    await p.getByRole("button", { name: "Disconnect", exact: true }).click();
    await p.close();
  } finally {
    await browser.close();
  }
  pass(
    "local and remote Hungarian login, persistent language, separate mobile Simple Mode, action feedback, source-edit cancel, and Contact",
  );
  await change("event.enable");
  assert.equal((await classroom.call("simple.actions.list")).locked, true);
  await assert.rejects(
    classroom.call("simple.action.execute", { id: "teacher" }),
    /event_locked/,
  );
  await assert.rejects(
    stage.call("simple.action.execute", { id: "stage" }),
    /event_locked/,
  );
  const locked = await new Client().open(name, "1234");
  assert.equal((await locked.call("simple.actions.list")).locked, true);
  await assert.rejects(
    locked.call("simple.action.execute", { id: "teacher" }),
    /event_locked/,
  );
  await locked.call("auth.logout");
  locked.close();
  assert.equal(
    (await admin.call("route.set", { receiver: first.id, source: sourceA }))
      .source,
    sourceA,
  );
  await change("event.disable");
  await new Promise((resolve) => setTimeout(resolve, 2100));
  assert.equal(
    (await classroom.call("simple.action.execute", { id: "teacher" })).source,
    sourceB,
  );
  await fault({ receiver: 0, sources: [sourceA] });
  await new Promise((resolve) => setTimeout(resolve, 2100));
  await assert.rejects(
    classroom.call("simple.action.execute", { id: "teacher" }),
    /unavailable/,
  );
  await fault({ receiver: 0, sources: [sourceA, sourceB, other] });
  await fault({ cloud: false });
  await new Promise((resolve) => setTimeout(resolve, 2200));
  assert.equal(
    (await classroom.call("simple.action.execute", { id: "teacher" })).source,
    sourceB,
  );
  await fault({ cloud: true });
  await classroom.call("auth.logout");
  classroom.close();
  stage.close();
  await change("event.enable");
  for (const key of Object.keys(dictionaries.en))
    assert(dictionaries.hu[key], `Missing Hungarian translation: ${key}`);
  pass(
    "Event Mode blocks existing and new remote sessions; administrators retain routing; deactivation restores actions; unavailable sources fail; local Simple Mode survives cloud outage",
  );
}
