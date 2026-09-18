import { test, expect } from "playwright/test";
import { ElectronCodexHarness } from "../../helpers/electron-codex";
import { FakeCodexAppServer } from "../../servers/fake-codex/server";

test.describe("server switching with active threads", () => {
  let harness: ElectronCodexHarness;

  test.beforeEach(async () => {
    harness = new ElectronCodexHarness();
    await harness.start();
  });

  test.afterEach(async () => harness.dispose());

  async function selectProfile(
    menu: Awaited<ReturnType<ElectronCodexHarness["waitForMenu"]>>,
    name: string,
  ): Promise<void> {
    await menu.bringToFront();
    await menu.getByRole("button", { name: "Codex", exact: true }).click({ force: true });
    await menu
      .locator(".codex-profile")
      .filter({ hasText: name })
      .getByRole("button", { name: "Select" })
      .click({ force: true });
  }

  test("isolates active threads and state while switching servers", async () => {
    harness.server.threads[0]!.preview = "Server A thread";
    const serverB = new FakeCodexAppServer({
      threads: [
        {
          id: "server-b-thread",
          preview: "Server B thread",
          cwd: "/tmp/server-b",
          projectId: "server-b-project",
        },
      ],
      projects: [
        {
          id: "server-b-project",
          name: "Server B project",
          roots: [{ path: "/tmp/server-b" }],
          metadata: {},
          position: 0,
          createdAt: 1,
          updatedAt: 1,
          recencyAt: null,
        },
      ],
    });
    await serverB.ready();
    harness.server.enableLongRunning();
    harness.writeConfig({
      codexAppServerProfiles: [
        { id: "server-a", name: "Server A", url: harness.server.url },
        { id: "server-b", name: "Server B", url: serverB.url },
      ],
      activeCodexAppServerProfileId: "server-a",
    });

    const app = await harness.launch({ ...process.env, PESK_E2E_SHOW_MENU: "1" });
    try {
      const menu = await harness.waitForMenu(app);
      const chat = await harness.waitForChat(app);
      await expect(chat.locator(".codex-session-trigger")).toContainText("Server A thread", {
        timeout: 10_000,
      });
      await chat.getByRole("textbox", { name: "Message Codex" }).fill("run on server A");
      await chat.getByRole("textbox", { name: "Message Codex" }).press("Enter");
      await expect(chat.locator("#codex-working-status")).toBeVisible({ timeout: 10_000 });

      await selectProfile(menu, "Server B");
      await expect(chat.locator(".codex-session-trigger")).toContainText("Server B thread", {
        timeout: 10_000,
      });
      await expect(chat.locator("#codex-working-status")).toBeHidden();
      await chat.locator(".codex-session-trigger").click();
      await expect(chat.locator("#codex-session-menu")).toContainText("Server B project");
      await expect(chat.locator("#codex-session-menu")).not.toContainText("Server A thread");

      // A late completion from the retired server must not update Server B.
      harness.server.completeLongRunning("e2e-thread-1");
      await expect(chat.locator(".codex-session-trigger")).toContainText("Server B thread");
      await expect(chat.locator("#codex-history-content")).not.toContainText(
        "Hello from fake Codex app-server.",
      );

      await selectProfile(menu, "Server A");
      await expect(chat.locator(".codex-session-trigger")).toContainText("Server A thread", {
        timeout: 10_000,
      });
      await expect(chat.locator("#codex-working-status")).toBeHidden();

      await selectProfile(menu, "Server B");
      await expect(chat.locator(".codex-session-trigger")).toContainText("Server B thread", {
        timeout: 10_000,
      });
      expect(serverB.threads.map((thread) => thread.id)).toEqual(["server-b-thread"]);
    } finally {
      await app.close();
      await serverB.close();
    }
  });

  test("does not leak pending approvals or notifications across servers", async () => {
    harness.server.threads[0]!.preview = "Approval on A";
    harness.server.enableApproval();
    const serverB = new FakeCodexAppServer({
      threads: [
        {
          id: "approval-server-b-thread",
          preview: "Clean server B",
          cwd: "/tmp/server-b",
          projectId: null,
        },
      ],
    });
    await serverB.ready();
    harness.writeConfig({
      codexAppServerProfiles: [
        { id: "server-a", name: "Server A", url: harness.server.url },
        { id: "server-b", name: "Server B", url: serverB.url },
      ],
      activeCodexAppServerProfileId: "server-a",
    });

    const app = await harness.launch({ ...process.env, PESK_E2E_SHOW_MENU: "1" });
    try {
      const menu = await harness.waitForMenu(app);
      const chat = await harness.waitForChat(app);
      const input = chat.getByRole("textbox", { name: "Message Codex" });
      await expect(chat.locator(".codex-session-trigger")).toContainText("Approval on A", {
        timeout: 10_000,
      });
      await input.fill("request approval on A");
      await input.press("Enter");
      await expect(chat.locator("#codex-user-input")).toContainText("echo approval-required", {
        timeout: 10_000,
      });

      await selectProfile(menu, "Server B");
      await expect(chat.locator(".codex-session-trigger")).toContainText("Clean server B", {
        timeout: 10_000,
      });
      await expect(chat.locator("#codex-user-input")).toBeHidden();

      harness.server.emitLateApprovalCompletion();
      expect(harness.server.lateMutationAttempts).toBe(1);
      await expect(chat.locator("#codex-user-input")).toBeHidden();
      await expect(chat.locator("#codex-history-content")).not.toContainText(
        "Hello from fake Codex app-server.",
      );

      await input.fill("prompt on clean server B");
      await input.press("Enter");
      await expect(chat.locator("#codex-history-content")).toContainText(
        "Hello from fake Codex app-server.",
        { timeout: 10_000 },
      );

      await selectProfile(menu, "Server A");
      await expect(chat.locator(".codex-session-trigger")).toContainText("Approval on A", {
        timeout: 10_000,
      });
      await expect(chat.locator("#codex-user-input")).toBeHidden();
    } finally {
      await app.close();
      await serverB.close();
    }
  });
});
