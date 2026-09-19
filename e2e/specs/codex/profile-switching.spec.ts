import { test, expect } from "../../helpers/electron-test";
import { FakeCodexAppServer } from "../../servers/fake-codex/server";
import { ElectronCodexHarness } from "../../helpers/electron-codex";
import * as fs from "node:fs";
import * as path from "node:path";

test.describe("Electron Codex profile switching", () => {
  let harness: ElectronCodexHarness;

  test.beforeEach(async ({ electronProfile }) => {
    harness = new ElectronCodexHarness(electronProfile);
    await harness.start();
  });

  test.afterEach(async () => harness.dispose());

  test("switches profiles, persists the active profile, and recovers from failure", async () => {
    const remote = new FakeCodexAppServer({
      threads: [
        {
          id: "remote-thread-1",
          preview: "Remote thread",
          cwd: "/tmp/pesk-e2e-remote",
          projectId: null,
        },
      ],
      projects: [
        {
          id: "remote-project",
          name: "Remote project",
          roots: [{ path: "/tmp/remote" }],
          metadata: {},
          position: 0,
          createdAt: 1,
          updatedAt: 1,
          recencyAt: null,
        },
      ],
    });
    await remote.ready();
    harness.writeConfig({
      codexAppServerProfiles: [
        { id: "local", name: "Local", url: harness.server.url },
        { id: "remote", name: "Remote", url: remote.url },
      ],
      activeCodexAppServerProfileId: "local",
    });

    let app = await harness.launch({ ...process.env, PESK_E2E_SHOW_MENU: "1" });
    const menu = await harness.waitForMenu(app);
    const chat = await harness.waitForChat(app);
    await expect(chat.locator(".codex-session-trigger")).toContainText("Fixture thread");

    await menu.waitForLoadState("domcontentloaded");
    await harness.focusWindow(app, menu);
    await menu.getByRole("button", { name: "Codex" }).click();
    const profiles = menu.locator(".codex-profile");
    await expect(profiles).toHaveCount(2);
    await profiles.filter({ hasText: "Remote" }).getByRole("button", { name: "Select" }).click();
    await expect(menu.locator(".codex-profile[aria-current='true']")).toContainText("Remote");
    await expect(chat.locator(".codex-session-trigger")).toContainText("Remote thread");

    const persisted = JSON.parse(
      fs.readFileSync(path.join(harness.userDataDirectory, "config.json"), "utf8"),
    ) as Record<string, unknown>;
    expect(persisted.activeCodexAppServerProfileId).toBe("remote");

    await app.close();
    app = await harness.launch({ ...process.env, PESK_E2E_SHOW_MENU: "1" });
    const relaunchedMenu = await harness.waitForMenu(app);
    const relaunchedChat = await harness.waitForChat(app);
    await relaunchedMenu.waitForLoadState("domcontentloaded");
    await harness.focusWindow(app, relaunchedMenu);
    await relaunchedMenu.getByRole("button", { name: "Codex" }).click();
    await expect(relaunchedMenu.locator(".codex-profile[aria-current='true']")).toContainText(
      "Remote",
    );
    await expect(relaunchedChat.locator(".codex-session-trigger")).toContainText("Remote thread");

    await remote.close();
    await harness.focusWindow(app, relaunchedMenu);
    await relaunchedMenu
      .locator(".codex-profile")
      .filter({ hasText: "Local" })
      .getByRole("button", { name: "Select" })
      .click();
    await expect(relaunchedChat.locator(".codex-session-trigger")).toContainText("Fixture thread");
    await remote.close();
  });

  test("adds, edits, and deletes an inactive profile from the Codex menu", async () => {
    const app = await harness.launch({ ...process.env, PESK_E2E_SHOW_MENU: "1" });
    const menu = await harness.waitForMenu(app);
    await menu.waitForLoadState("domcontentloaded");
    await harness.focusWindow(app, menu);
    await menu.getByRole("button", { name: "Codex" }).click();

    const onlyProfile = menu.locator(".codex-profile").filter({ hasText: "E2E" });
    await expect(onlyProfile.getByRole("button", { name: "Delete" })).toBeDisabled();

    await menu.getByRole("textbox", { name: "New profile name" }).fill("Temporary");
    await menu.getByRole("textbox", { name: "New profile URL" }).fill(harness.server.url);
    await menu.getByRole("button", { name: "Add app-server" }).click();
    await expect(menu.locator(".codex-profile")).toHaveCount(2);
    await expect(
      menu.locator(".codex-profile").filter({ hasText: "E2E" }).getByRole("button", {
        name: "Delete",
      }),
    ).toBeDisabled();

    await menu.getByRole("textbox", { name: "New profile name" }).fill("Secure");
    await menu.getByRole("textbox", { name: "New profile URL" }).fill("wss://codex.example.test");
    await menu.getByRole("button", { name: "Add app-server" }).click();
    await expect(menu.locator(".codex-profile")).toHaveCount(3);

    const temporary = menu.locator(".codex-profile").filter({ hasText: "Temporary" });
    await temporary.getByRole("button", { name: "Edit" }).click();
    await menu.getByRole("textbox", { name: "Temporary profile name" }).fill("Renamed");
    await menu.getByRole("button", { name: "Save" }).click();
    await expect(menu.locator(".codex-profile").filter({ hasText: "Renamed" })).toBeVisible();

    const renamed = menu.locator(".codex-profile").filter({ hasText: "Renamed" });
    await renamed.getByRole("button", { name: "Delete" }).click();
    await renamed.getByRole("button", { name: "Confirm delete" }).click();
    const secure = menu.locator(".codex-profile").filter({ hasText: "Secure" });
    await secure.getByRole("button", { name: "Delete" }).click();
    await secure.getByRole("button", { name: "Confirm delete" }).click();
    await expect(menu.locator(".codex-profile")).toHaveCount(1);
    await expect(menu.locator(".codex-profile")).toContainText("E2E");
    await expect(
      menu.locator(".codex-profile").getByRole("button", { name: "Delete" }),
    ).toBeDisabled();
  });

  test("rejects invalid and duplicate profile definitions", async () => {
    const app = await harness.launch({ ...process.env, PESK_E2E_SHOW_MENU: "1" });
    const menu = await harness.waitForMenu(app);
    await menu.waitForLoadState("domcontentloaded");
    await harness.focusWindow(app, menu);
    await menu.getByRole("button", { name: "Codex" }).click();

    await menu.getByRole("textbox", { name: "New profile name" }).fill("Invalid");
    await menu.getByRole("textbox", { name: "New profile URL" }).fill("http://not-websocket");
    await menu.getByRole("button", { name: "Add app-server" }).click();
    await expect(menu.locator(".codex-profile-error")).toContainText(/WebSocket|ws:\/\//i);

    await menu.getByRole("textbox", { name: "New profile name" }).fill("E2E");
    await menu.getByRole("textbox", { name: "New profile URL" }).fill(harness.server.url);
    await menu.getByRole("button", { name: "Add app-server" }).click();
    await expect(menu.locator(".codex-profile-error")).toContainText(/duplicate|already exists/i);
  });

  test("restores local projects after switching back from a remote server", async () => {
    harness.server.projects.push({
      id: "local-project",
      name: "Local project",
      roots: [{ path: "/tmp/local" }],
      metadata: {},
      position: 0,
      createdAt: 1,
      updatedAt: 1,
      recencyAt: null,
    });
    harness.server.threads[0]!.projectId = "local-project";
    const remote = new FakeCodexAppServer({
      threads: [
        {
          id: "remote-thread",
          preview: "Remote thread",
          cwd: "/tmp/remote",
          projectId: "remote-project",
        },
      ],
      projects: [
        {
          id: "remote-project",
          name: "Remote project",
          roots: [{ path: "/tmp/remote" }],
          metadata: {},
          position: 0,
          createdAt: 1,
          updatedAt: 1,
          recencyAt: null,
        },
      ],
    });
    await remote.ready();
    harness.writeConfig({
      codexAppServerProfiles: [
        { id: "local", name: "Local", url: harness.server.url },
        { id: "remote", name: "Remote", url: remote.url },
      ],
      activeCodexAppServerProfileId: "local",
    });
    const app = await harness.launch({ ...process.env, PESK_E2E_SHOW_MENU: "1" });
    const menu = await harness.waitForMenu(app);
    const chat = await harness.waitForChat(app);
    await expect(chat.locator(".codex-session-trigger")).toContainText("Fixture thread");
    await harness.focusWindow(app, menu);
    await menu.getByRole("button", { name: "Codex" }).click();
    await menu
      .locator(".codex-profile")
      .filter({ hasText: "Remote" })
      .getByRole("button", { name: "Select" })
      .click();
    await expect(chat.locator(".codex-session-trigger")).toContainText("Remote thread");
    await expect(chat.locator("#codex-session-menu")).toBeHidden();
    await chat.locator(".codex-session-trigger").click();
    await expect(chat.locator("#codex-session-menu")).toContainText("Remote project");

    await harness.focusWindow(app, menu);
    await menu
      .locator(".codex-profile")
      .filter({ hasText: "Local" })
      .getByRole("button", { name: "Select" })
      .click();
    await expect(chat.locator(".codex-session-trigger")).toContainText("Fixture thread");
    await chat.locator(".codex-session-trigger").click();
    await expect(chat.locator("#codex-session-menu")).toContainText("Local project");
    await expect(chat.locator("#codex-session-menu")).not.toContainText("Remote project");
    await remote.close();
  });

  test("keeps profile configuration usable after selecting an unavailable server", async () => {
    const remote = new FakeCodexAppServer();
    await remote.ready();
    const remoteUrl = remote.url;
    await remote.close();
    harness.writeConfig({
      codexAppServerProfiles: [
        { id: "local", name: "Local", url: harness.server.url },
        { id: "remote", name: "Remote", url: remoteUrl },
      ],
      activeCodexAppServerProfileId: "local",
    });
    const app = await harness.launch({ ...process.env, PESK_E2E_SHOW_MENU: "1" });
    const menu = await harness.waitForMenu(app);
    const chat = await harness.waitForChat(app);
    await harness.focusWindow(app, menu);
    await menu.getByRole("button", { name: "Codex" }).click();
    await menu
      .locator(".codex-profile")
      .filter({ hasText: "Remote" })
      .getByRole("button", { name: "Select" })
      .click();
    await expect(chat.locator(".codex-session-trigger")).toContainText("No active session");
    const persisted = JSON.parse(
      fs.readFileSync(path.join(harness.userDataDirectory, "config.json"), "utf8"),
    ) as {
      codexAppServerProfiles: Array<{ name: string }>;
      activeCodexAppServerProfileId: string;
    };
    expect(persisted.codexAppServerProfiles.map((profile) => profile.name)).toEqual([
      "Local",
      "Remote",
    ]);
    expect(persisted.activeCodexAppServerProfileId).toBe("remote");

    await harness.focusWindow(app, menu);
    await menu
      .locator(".codex-profile")
      .filter({ hasText: "Local" })
      .getByRole("button", { name: "Select" })
      .click();
    await expect(chat.locator(".codex-session-trigger")).toContainText("Fixture thread");
  });

  test("clears an active turn when switching app-server profiles", async () => {
    harness.server.enableLongRunning();
    const remote = new FakeCodexAppServer({
      threads: [
        {
          id: "remote-thread",
          preview: "Remote thread",
          cwd: "/tmp/remote",
          projectId: null,
        },
      ],
    });
    await remote.ready();
    harness.writeConfig({
      codexAppServerProfiles: [
        { id: "local", name: "Local", url: harness.server.url },
        { id: "remote", name: "Remote", url: remote.url },
      ],
      activeCodexAppServerProfileId: "local",
    });
    const app = await harness.launch({ ...process.env, PESK_E2E_SHOW_MENU: "1" });
    const chat = await harness.waitForChat(app);
    await chat.getByRole("textbox", { name: "Message Codex" }).fill("keep running");
    await chat.getByRole("textbox", { name: "Message Codex" }).press("Enter");
    await expect(chat.locator("#codex-working-status")).toBeVisible();

    const menu = await harness.waitForMenu(app);
    await harness.focusWindow(app, menu);
    await menu.getByRole("button", { name: "Codex" }).click();
    await menu
      .locator(".codex-profile")
      .filter({ hasText: "Remote" })
      .getByRole("button", { name: "Select" })
      .click();
    await expect(chat.locator(".codex-session-trigger")).toContainText("Remote thread");
    await expect(chat.locator("#codex-working-status")).toBeHidden();
    await remote.close();
  });
});
