import { test, expect } from "../../helpers/electron-test";
import { ElectronCodexHarness } from "../../helpers/electron-codex";

test.describe("Electron file-change activity", () => {
  let harness: ElectronCodexHarness;

  test.beforeEach(async ({ electronProfile }) => {
    harness = new ElectronCodexHarness(electronProfile);
    await harness.start();
  });

  test.afterEach(async () => harness.dispose());

  test("renders a file-change event with its path and diff", async () => {
    harness.server.enableFileChange();
    const app = await harness.launch();
    const chat = await harness.waitForChat(app);
    await expect(chat.locator(".codex-session-trigger")).toContainText("Fixture thread");
    const input = chat.getByRole("textbox", { name: "Message Codex" });
    await input.fill("modify the example file");
    await input.press("Enter");
    const change = chat.locator(".codex-file-change-details");
    await expect(change).toBeVisible();
    await expect(change.locator(".codex-file-change-path")).toHaveText("modified: src/example.ts");
    await expect(change.locator(".codex-file-change-diff")).toContainText("+new");
  });

  test("renders added, modified, and deleted files in one turn", async () => {
    harness.server.enableFileChange([
      { kind: "added", path: "src/added.ts", diff: "@@ -0,0 +1 @@\n+export {};" },
      { kind: "modified", path: "src/changed.ts", diff: "@@ -1 +1 @@\n-old\n+new" },
      { kind: "deleted", path: "src/removed.ts", diff: "@@ -1 +0,0 @@\n-deleted" },
    ]);
    const app = await harness.launch();
    const chat = await harness.waitForChat(app);
    await expect(chat.locator(".codex-session-trigger")).toContainText("Fixture thread");
    const input = chat.getByRole("textbox", { name: "Message Codex" });
    await input.fill("update all example files");
    await input.press("Enter");

    const change = chat.locator(".codex-file-change-details");
    await expect(change).toBeVisible();
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
  });

  test("restores file changes with their thread after reopening it", async () => {
    harness.server.enableFileChange();
    let app = await harness.launch();
    const chat = await harness.waitForChat(app);
    await expect(chat.locator(".codex-session-trigger")).toContainText("Fixture thread");
    const input = chat.getByRole("textbox", { name: "Message Codex" });
    await input.fill("persist the example file change");
    await input.press("Enter");
    await expect(chat.locator(".codex-file-change-path")).toHaveText("modified: src/example.ts");

    await app.close();
    app = await harness.launch();
    const relaunchedChat = await harness.waitForChat(app);
    await expect(relaunchedChat.locator(".codex-file-change-path")).toHaveText(
      "modified: src/example.ts",
    );
    await expect(relaunchedChat.locator(".codex-file-change-diff")).toContainText("+new");
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
    const chat = await harness.waitForChat(app);
    const trigger = chat.locator(".codex-session-trigger");
    await expect(trigger).toContainText("Fixture thread");
    const input = chat.getByRole("textbox", { name: "Message Codex" });
    await input.fill("change the first thread file");
    await input.press("Enter");
    await expect(chat.locator(".codex-file-change-path")).toHaveText("modified: src/example.ts");

    await harness.showChat(app);
    await trigger.click();
    const secondThread = chat
      .locator("#codex-session-menu")
      .getByRole("option", { name: /Second file thread/ });
    await expect(secondThread).toBeVisible();
    await secondThread.click();
    await expect(trigger).toContainText("Second file thread");
    await expect(chat.locator(".codex-file-change-path")).toHaveCount(0);

    await harness.showChat(app);
    await trigger.click();
    const firstThread = chat
      .locator("#codex-session-menu")
      .getByRole("option", { name: /Fixture thread/ });
    await expect(firstThread).toBeVisible();
    await firstThread.click();
    await expect(chat.locator(".codex-file-change-path")).toHaveText("modified: src/example.ts");
  });
});
