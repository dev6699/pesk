import { test, expect } from "playwright/test";
import { ElectronCodexHarness } from "../../helpers/electron-codex";

test.describe("Electron file-change activity", () => {
  let harness: ElectronCodexHarness;

  test.beforeEach(async () => {
    harness = new ElectronCodexHarness();
    await harness.start();
  });

  test.afterEach(async () => harness.dispose());

  test("renders a file-change event with its path and diff", async () => {
    harness.server.enableFileChange();
    const app = await harness.launch();
    try {
      const chat = await harness.waitForChat(app);
      await expect(chat.locator(".codex-session-trigger")).toContainText("Fixture thread", {
        timeout: 10_000,
      });
      const input = chat.getByRole("textbox", { name: "Message Codex" });
      await input.fill("modify the example file");
      await input.press("Enter");
      const change = chat.locator(".codex-file-change-details");
      await expect(change).toBeVisible({ timeout: 10_000 });
      await expect(change.locator(".codex-file-change-path")).toHaveText(
        "modified: src/example.ts",
      );
      await expect(change.locator(".codex-file-change-diff")).toContainText("+new");
    } finally {
      await app.close();
    }
  });

  test("renders added, modified, and deleted files in one turn", async () => {
    harness.server.enableFileChange([
      { kind: "added", path: "src/added.ts", diff: "@@ -0,0 +1 @@\n+export {};" },
      { kind: "modified", path: "src/changed.ts", diff: "@@ -1 +1 @@\n-old\n+new" },
      { kind: "deleted", path: "src/removed.ts", diff: "@@ -1 +0,0 @@\n-deleted" },
    ]);
    const app = await harness.launch();
    try {
      const chat = await harness.waitForChat(app);
      await expect(chat.locator(".codex-session-trigger")).toContainText("Fixture thread", {
        timeout: 10_000,
      });
      const input = chat.getByRole("textbox", { name: "Message Codex" });
      await input.fill("update all example files");
      await input.press("Enter");

      const change = chat.locator(".codex-file-change-details");
      await expect(change).toBeVisible({ timeout: 10_000 });
      await expect(change.locator(".codex-file-change-path")).toHaveText([
        "added: src/added.ts",
        "modified: src/changed.ts",
        "deleted: src/removed.ts",
      ]);
      await expect(change.locator(".codex-file-change-diff")).toContainText([
        "+export {};",
        "+new",
        "-deleted",
      ]);
    } finally {
      await app.close();
    }
  });

  test("restores file changes with their thread after reopening it", async () => {
    harness.server.enableFileChange();
    let app = await harness.launch();
    try {
      const chat = await harness.waitForChat(app);
      await expect(chat.locator(".codex-session-trigger")).toContainText("Fixture thread", {
        timeout: 10_000,
      });
      const input = chat.getByRole("textbox", { name: "Message Codex" });
      await input.fill("persist the example file change");
      await input.press("Enter");
      await expect(chat.locator(".codex-file-change-path")).toHaveText("modified: src/example.ts", {
        timeout: 10_000,
      });

      await app.close();
      app = await harness.launch();
      const relaunchedChat = await harness.waitForChat(app);
      await expect(relaunchedChat.locator(".codex-file-change-path")).toHaveText(
        "modified: src/example.ts",
        { timeout: 10_000 },
      );
      await expect(relaunchedChat.locator(".codex-file-change-diff")).toContainText("+new");
    } finally {
      await app.close();
    }
  });

  test("keeps file changes associated with the selected thread", async () => {
    harness.server.threads.push({
      id: "file-change-thread-2",
      preview: "Second file thread",
      cwd: "/tmp/pesk-e2e-workspace",
      projectId: null,
    });
    harness.server.enableFileChange();
    const app = await harness.launch();
    try {
      const chat = await harness.waitForChat(app);
      const trigger = chat.locator(".codex-session-trigger");
      await expect(trigger).toContainText("Fixture thread", { timeout: 10_000 });
      const input = chat.getByRole("textbox", { name: "Message Codex" });
      await input.fill("change the first thread file");
      await input.press("Enter");
      await expect(chat.locator(".codex-file-change-path")).toHaveText("modified: src/example.ts", {
        timeout: 10_000,
      });

      await harness.showChat(app);
      await trigger.click({ force: true });
      const secondThread = chat
        .locator("#codex-session-menu")
        .getByRole("option", { name: /Second file thread/ });
      await expect(secondThread).toBeVisible();
      await secondThread.click({ force: true });
      await expect(trigger).toContainText("Second file thread");
      await expect(chat.locator(".codex-file-change-path")).toHaveCount(0);

      await harness.showChat(app);
      await trigger.click({ force: true });
      const firstThread = chat
        .locator("#codex-session-menu")
        .getByRole("option", { name: /Fixture thread/ });
      await expect(firstThread).toBeVisible();
      await firstThread.click({ force: true });
      await expect(chat.locator(".codex-file-change-path")).toHaveText("modified: src/example.ts", {
        timeout: 10_000,
      });
    } finally {
      await app.close();
    }
  });
});
