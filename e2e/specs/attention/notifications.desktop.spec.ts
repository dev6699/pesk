import { test, expect } from "../../helpers/electron-test";
import { ElectronCodexHarness } from "../../helpers/electron-codex";

test.describe("Electron attention workflows", () => {
  let harness: ElectronCodexHarness;

  test.beforeEach(async ({ electronProfile }) => {
    harness = new ElectronCodexHarness(electronProfile);
    await harness.start();
  });

  test.afterEach(async () => harness.dispose());

  test("brings the approval workflow to attention while chat is hidden", async () => {
    harness.server.enableApproval();
    harness.server.setTurnDelay(500);
    const app = await harness.launch();
    const chat = await harness.waitForChat(app);
    const pet = app.windows().find((window) => window.url().includes("pet.html"));
    if (!pet) throw new Error("Electron pet window did not open");

    await chat.getByRole("textbox", { name: "Message Codex" }).fill("run a command");
    await chat.getByRole("textbox", { name: "Message Codex" }).press("Enter");
    await app.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()
        .find((window) => window.webContents.getURL().includes("chat.html"))
        ?.hide();
      BrowserWindow.getAllWindows()
        .find((window) => window.webContents.getURL().includes("pet.html"))
        ?.hide();
      BrowserWindow.getFocusedWindow()?.blur();
    });
    await expect(chat.locator("#codex-user-input")).toContainText("echo approval-required");
    await expect(pet.locator("#pet")).toBeVisible();
    await expect
      .poll(() =>
        app.evaluate(({ BrowserWindow }) =>
          BrowserWindow.getAllWindows()
            .find((window) => window.webContents.getURL().includes("chat.html"))
            ?.isVisible(),
        ),
      )
      .toBe(true);
    const approval = chat.locator("#codex-user-input");
    await approval.getByRole("radio", { name: /Approve once/ }).check();
    await approval.getByRole("button", { name: "Submit" }).click();
    await expect(chat.locator("#codex-user-input")).toBeHidden();
  });

  test("keeps attention and running state independent across threads", async () => {
    harness.server.threads[0]!.preview = "Thread A";
    harness.server.threads.push(
      {
        id: "attention-thread-b",
        preview: "Thread B",
        cwd: "/tmp/pesk-e2e-workspace",
        projectId: null,
      },
      {
        id: "attention-thread-c",
        preview: "Thread C",
        cwd: "/tmp/pesk-e2e-workspace",
        projectId: null,
      },
    );
    const app = await harness.launch();
    const chat = await harness.waitForChat(app);
    const pet = app.windows().find((window) => window.url().includes("pet.html"));
    if (!pet) throw new Error("Electron pet window did not open");
    await expect(chat.locator(".codex-session-trigger")).toContainText("Thread A");

    await app.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()
        .find((window) => window.webContents.getURL().includes("chat.html"))
        ?.hide();
      BrowserWindow.getAllWindows()
        .find((window) => window.webContents.getURL().includes("pet.html"))
        ?.hide();
      BrowserWindow.getFocusedWindow()?.blur();
    });
    harness.server.emitApprovalForThread("e2e-thread-1", "echo thread-a");
    await expect(chat.locator(".codex-session-trigger")).toContainText("Thread A");
    await expect(chat.locator("#codex-user-input")).toContainText("echo thread-a");

    harness.server.emitApprovalForThread("attention-thread-b", "echo thread-b");
    harness.server.emitTurnStartedForThread("attention-thread-c");
    const aggregate = pet.locator("#codex-aggregate-status-label");
    await expect(aggregate).toHaveAttribute("title", /Thread B: Waiting · needs approval/);
    await expect(aggregate).toHaveAttribute("title", /Thread C: Working/);
    await expect(pet.locator("#pet")).toBeVisible();

    // Thread A is open while B still needs attention; opening A must not clear B.
    await expect(chat.locator(".codex-session-trigger")).toContainText("Thread A");
    await expect(aggregate).toHaveAttribute("title", /Thread B: Waiting · needs approval/);
  });
});
