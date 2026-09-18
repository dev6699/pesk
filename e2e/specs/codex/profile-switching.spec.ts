import { test, expect } from "playwright/test";
import { FakeCodexAppServer } from "../../servers/fake-codex/server";
import { ElectronCodexHarness } from "../../helpers/electron-codex";
import * as fs from "node:fs";
import * as path from "node:path";

test.describe("Electron Codex profile switching", () => {
  let harness: ElectronCodexHarness;

  test.beforeEach(async () => {
    harness = new ElectronCodexHarness();
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
    try {
      const menu = await harness.waitForMenu(app);
      const chat = await harness.waitForChat(app);
      await expect(chat.locator(".codex-session-trigger")).toContainText("Fixture thread", {
        timeout: 10_000,
      });

      await menu.waitForLoadState("domcontentloaded");
      await menu.bringToFront();
      await menu.getByRole("button", { name: "Codex" }).click({ force: true });
      const profiles = menu.locator(".codex-profile");
      await expect(profiles).toHaveCount(2);
      await profiles
        .filter({ hasText: "Remote" })
        .getByRole("button", { name: "Select" })
        .click({ force: true });
      await expect(menu.locator(".codex-profile[aria-current='true']")).toContainText("Remote");
      await expect(chat.locator(".codex-session-trigger")).toContainText("Remote thread", {
        timeout: 10_000,
      });

      const persisted = JSON.parse(
        fs.readFileSync(path.join(harness.userDataDirectory, "config.json"), "utf8"),
      ) as Record<string, unknown>;
      expect(persisted.activeCodexAppServerProfileId).toBe("remote");

      await app.close();
      app = await harness.launch({ ...process.env, PESK_E2E_SHOW_MENU: "1" });
      const relaunchedMenu = await harness.waitForMenu(app);
      const relaunchedChat = await harness.waitForChat(app);
      await relaunchedMenu.waitForLoadState("domcontentloaded");
      await relaunchedMenu.bringToFront();
      await relaunchedMenu.getByRole("button", { name: "Codex" }).click({ force: true });
      await expect(relaunchedMenu.locator(".codex-profile[aria-current='true']")).toContainText(
        "Remote",
      );
      await expect(relaunchedChat.locator(".codex-session-trigger")).toContainText(
        "Remote thread",
        { timeout: 10_000 },
      );

      await remote.close();
      await relaunchedMenu.bringToFront();
      await relaunchedMenu
        .locator(".codex-profile")
        .filter({ hasText: "Local" })
        .getByRole("button", { name: "Select" })
        .click({ force: true });
      await expect(relaunchedChat.locator(".codex-session-trigger")).toContainText(
        "Fixture thread",
        {
          timeout: 10_000,
        },
      );
    } finally {
      await app.close();
      await remote.close();
    }
  });

  test("adds, edits, and deletes an inactive profile from the Codex menu", async () => {
    test.setTimeout(60_000);
    const app = await harness.launch({ ...process.env, PESK_E2E_SHOW_MENU: "1" });
    try {
      const menu = await harness.waitForMenu(app);
      await menu.waitForLoadState("domcontentloaded");
      await menu.bringToFront();
      await menu.getByRole("button", { name: "Codex" }).click({ force: true });

      const onlyProfile = menu.locator(".codex-profile").filter({ hasText: "E2E" });
      await expect(onlyProfile.getByRole("button", { name: "Delete" })).toBeDisabled();

      await menu.getByRole("textbox", { name: "New profile name" }).fill("Temporary");
      await menu.getByRole("textbox", { name: "New profile URL" }).fill(harness.server.url);
      await menu.getByRole("button", { name: "Add app-server" }).click({ force: true });
      await expect(menu.locator(".codex-profile")).toHaveCount(2);
      await expect(
        menu.locator(".codex-profile").filter({ hasText: "E2E" }).getByRole("button", {
          name: "Delete",
        }),
      ).toBeDisabled();

      await menu.getByRole("textbox", { name: "New profile name" }).fill("Secure");
      await menu.getByRole("textbox", { name: "New profile URL" }).fill("wss://codex.example.test");
      await menu.getByRole("button", { name: "Add app-server" }).click({ force: true });
      await expect(menu.locator(".codex-profile")).toHaveCount(3);

      const temporary = menu.locator(".codex-profile").filter({ hasText: "Temporary" });
      await temporary.getByRole("button", { name: "Edit" }).click({ force: true });
      await menu.getByRole("textbox", { name: "Temporary profile name" }).fill("Renamed");
      await menu.getByRole("button", { name: "Save" }).click({ force: true });
      await expect(menu.locator(".codex-profile").filter({ hasText: "Renamed" })).toBeVisible();

      const renamed = menu.locator(".codex-profile").filter({ hasText: "Renamed" });
      await renamed.getByRole("button", { name: "Delete" }).click({ force: true });
      await renamed.getByRole("button", { name: "Confirm delete" }).click({ force: true });
      const secure = menu.locator(".codex-profile").filter({ hasText: "Secure" });
      await secure.getByRole("button", { name: "Delete" }).click({ force: true });
      await secure.getByRole("button", { name: "Confirm delete" }).click({ force: true });
      await expect(menu.locator(".codex-profile")).toHaveCount(1);
      await expect(menu.locator(".codex-profile")).toContainText("E2E");
      await expect(
        menu.locator(".codex-profile").getByRole("button", { name: "Delete" }),
      ).toBeDisabled();
    } finally {
      await app.close();
    }
  });

  test("rejects invalid and duplicate profile definitions", async () => {
    const app = await harness.launch({ ...process.env, PESK_E2E_SHOW_MENU: "1" });
    try {
      const menu = await harness.waitForMenu(app);
      await menu.waitForLoadState("domcontentloaded");
      await menu.bringToFront();
      await menu.getByRole("button", { name: "Codex" }).click({ force: true });

      await menu.getByRole("textbox", { name: "New profile name" }).fill("Invalid");
      await menu.getByRole("textbox", { name: "New profile URL" }).fill("http://not-websocket");
      await menu.getByRole("button", { name: "Add app-server" }).click({ force: true });
      await expect(menu.locator(".codex-profile-error")).toContainText(/WebSocket|ws:\/\//i);

      await menu.getByRole("textbox", { name: "New profile name" }).fill("E2E");
      await menu.getByRole("textbox", { name: "New profile URL" }).fill(harness.server.url);
      await menu.getByRole("button", { name: "Add app-server" }).click({ force: true });
      await expect(menu.locator(".codex-profile-error")).toContainText(/duplicate|already exists/i);
    } finally {
      await app.close();
    }
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
    try {
      const menu = await harness.waitForMenu(app);
      const chat = await harness.waitForChat(app);
      await expect(chat.locator(".codex-session-trigger")).toContainText("Fixture thread", {
        timeout: 10_000,
      });
      await menu.bringToFront();
      await menu.getByRole("button", { name: "Codex" }).click({ force: true });
      await menu
        .locator(".codex-profile")
        .filter({ hasText: "Remote" })
        .getByRole("button", { name: "Select" })
        .click({ force: true });
      await expect(chat.locator(".codex-session-trigger")).toContainText("Remote thread", {
        timeout: 10_000,
      });
      await expect(chat.locator("#codex-session-menu")).toBeHidden();
      await chat.locator(".codex-session-trigger").click();
      await expect(chat.locator("#codex-session-menu")).toContainText("Remote project");

      await menu.bringToFront();
      await menu
        .locator(".codex-profile")
        .filter({ hasText: "Local" })
        .getByRole("button", { name: "Select" })
        .click({ force: true });
      await expect(chat.locator(".codex-session-trigger")).toContainText("Fixture thread", {
        timeout: 10_000,
      });
      await chat.locator(".codex-session-trigger").click();
      await expect(chat.locator("#codex-session-menu")).toContainText("Local project");
      await expect(chat.locator("#codex-session-menu")).not.toContainText("Remote project");
    } finally {
      await app.close();
      await remote.close();
    }
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
    try {
      const menu = await harness.waitForMenu(app);
      const chat = await harness.waitForChat(app);
      await menu.bringToFront();
      await menu.getByRole("button", { name: "Codex" }).click({ force: true });
      await menu
        .locator(".codex-profile")
        .filter({ hasText: "Remote" })
        .getByRole("button", { name: "Select" })
        .click({ force: true });
      await expect(chat.locator(".codex-session-trigger")).toContainText("No active session", {
        timeout: 10_000,
      });
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

      await menu.bringToFront();
      await menu
        .locator(".codex-profile")
        .filter({ hasText: "Local" })
        .getByRole("button", { name: "Select" })
        .click({ force: true });
      await expect(chat.locator(".codex-session-trigger")).toContainText("Fixture thread", {
        timeout: 10_000,
      });
    } finally {
      await app.close();
    }
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
    try {
      const chat = await harness.waitForChat(app);
      await chat.getByRole("textbox", { name: "Message Codex" }).fill("keep running");
      await chat.getByRole("textbox", { name: "Message Codex" }).press("Enter");
      await expect(chat.locator("#codex-working-status")).toBeVisible({ timeout: 10_000 });

      const menu = await harness.waitForMenu(app);
      await menu.bringToFront();
      await menu.getByRole("button", { name: "Codex" }).click({ force: true });
      await menu
        .locator(".codex-profile")
        .filter({ hasText: "Remote" })
        .getByRole("button", { name: "Select" })
        .click({ force: true });
      await expect(chat.locator(".codex-session-trigger")).toContainText("Remote thread", {
        timeout: 10_000,
      });
      await expect(chat.locator("#codex-working-status")).toBeHidden();
    } finally {
      await app.close();
      await remote.close();
    }
  });
});
