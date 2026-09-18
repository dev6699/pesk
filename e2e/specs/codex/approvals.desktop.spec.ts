import { test, expect } from "playwright/test";
import { ElectronCodexHarness } from "../../helpers/electron-codex";
import { FakeCodexAppServer } from "../../servers/fake-codex/server";

test.describe("Electron Codex approval and question workflows", () => {
  let harness: ElectronCodexHarness;

  test.beforeEach(async () => {
    harness = new ElectronCodexHarness();
    await harness.start();
  });

  test.afterEach(async () => harness.dispose());

  test("round-trips an app-server approval request from the desktop chat", async () => {
    harness.server.enableApproval();
    const app = await harness.launch();
    try {
      const chat = await harness.waitForChat(app);
      await expect(chat.locator(".codex-session-trigger")).toContainText("Fixture thread", {
        timeout: 10_000,
      });
      const input = chat.getByRole("textbox", { name: "Message Codex" });
      await input.fill("run the approved command");
      await input.press("Enter");
      const approval = chat.locator("#codex-user-input");
      await expect(approval).toContainText("echo approval-required", { timeout: 10_000 });
      await approval.getByRole("radio", { name: /Approve once/ }).check();
      await approval.getByRole("button", { name: "Submit" }).click();
      await expect(chat.locator("#codex-history-content")).toContainText(
        "Hello from fake Codex app-server.",
        { timeout: 10_000 },
      );
      expect(harness.server.permissionResponses).toEqual([{ decision: "accept" }]);
    } finally {
      await app.close();
    }
  });

  test("round-trips an app-server question from the desktop chat", async () => {
    harness.server.enableUserInput();
    const app = await harness.launch();
    try {
      const chat = await harness.waitForChat(app);
      await expect(chat.locator(".codex-session-trigger")).toContainText("Fixture thread", {
        timeout: 10_000,
      });
      const input = chat.getByRole("textbox", { name: "Message Codex" });
      await input.fill("ask me a question");
      await input.press("Enter");
      const question = chat.locator("#codex-user-input");
      await expect(question).toContainText("Which environment?", { timeout: 10_000 });
      await question.getByRole("radio", { name: /Test/ }).check();
      await question.getByRole("button", { name: "Submit" }).click();
      await expect(chat.locator("#codex-history-content")).toContainText(
        "Hello from fake Codex app-server.",
        { timeout: 10_000 },
      );
      expect(harness.server.userInputResponses).toEqual([
        { answers: { choice: { answers: ["Test"] } } },
      ]);
    } finally {
      await app.close();
    }
  });

  test("round-trips a rejected app-server approval", async () => {
    harness.server.enableApproval();
    const app = await harness.launch();
    try {
      const chat = await harness.waitForChat(app);
      const input = chat.getByRole("textbox", { name: "Message Codex" });
      await input.fill("run the rejected command");
      await input.press("Enter");
      const approval = chat.locator("#codex-user-input");
      await expect(approval).toContainText("echo approval-required", { timeout: 10_000 });
      await approval.getByRole("radio", { name: /Decline/ }).check();
      await approval.getByRole("button", { name: "Submit" }).click();
      await expect(chat.locator("#codex-history-content")).toContainText(
        "Hello from fake Codex app-server.",
        { timeout: 10_000 },
      );
      expect(harness.server.permissionResponses).toEqual([{ decision: "decline" }]);
    } finally {
      await app.close();
    }
  });

  test("resolves multiple pending app-server approvals without cross-wiring them", async () => {
    harness.server.enableMultipleApprovals();
    const app = await harness.launch();
    try {
      const chat = await harness.waitForChat(app);
      await expect(chat.locator(".codex-session-trigger")).toContainText("Fixture thread", {
        timeout: 10_000,
      });
      const input = chat.getByRole("textbox", { name: "Message Codex" });
      await input.fill("run two commands");
      await input.press("Enter");

      const approval = chat.locator("#codex-user-input");
      await expect(approval).toContainText("echo second-approval-required", { timeout: 10_000 });
      await approval.getByRole("radio", { name: /Decline/ }).check();
      await approval.getByRole("button", { name: "Submit" }).click();

      await expect(approval).toContainText("echo approval-required", { timeout: 10_000 });
      await approval.getByRole("radio", { name: /Approve once/ }).check();
      await approval.getByRole("button", { name: "Submit" }).click();
      await expect(chat.locator("#codex-history-content")).toContainText(
        "Hello from fake Codex app-server.",
        { timeout: 10_000 },
      );
      expect(harness.server.permissionResponses).toEqual([
        { decision: "decline" },
        { decision: "accept" },
      ]);
    } finally {
      await app.close();
    }
  });

  test("clears a pending approval when switching app-server profiles", async () => {
    harness.server.enableApproval();
    const remote = new FakeCodexAppServer({
      threads: [
        {
          id: "remote-thread-1",
          preview: "Remote thread",
          cwd: "/tmp/pesk-e2e-remote",
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
      const input = chat.getByRole("textbox", { name: "Message Codex" });
      await input.fill("run before switching");
      await input.press("Enter");
      await expect(chat.locator("#codex-user-input")).toContainText("echo approval-required", {
        timeout: 10_000,
      });

      const menu = await harness.waitForMenu(app);
      await menu.waitForLoadState("domcontentloaded");
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
      await expect(chat.locator("#codex-user-input")).toBeHidden();

      harness.server.emitLateApprovalCompletion();
      expect(harness.server.lateMutationAttempts).toBe(1);
      await expect(chat.locator(".codex-session-trigger")).toContainText("Remote thread");
      await expect(chat.locator("#codex-user-input")).toBeHidden();
      await expect(chat.locator("#codex-history-content")).not.toContainText(
        "Hello from fake Codex app-server.",
      );
    } finally {
      await app.close();
      await remote.close();
    }
  });
});
