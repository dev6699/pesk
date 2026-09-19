import { test, expect } from "../../helpers/electron-test";
import { ElectronCodexHarness } from "../../helpers/electron-codex";
import { FakeCodexAppServer } from "../../servers/fake-codex/server";

test.describe("Electron Codex connection", () => {
  let harness: ElectronCodexHarness;

  test.beforeEach(async ({ electronProfile }) => {
    harness = new ElectronCodexHarness(electronProfile);
    await harness.start();
  });

  test.afterEach(async () => harness.dispose());

  test("connects through the main process and loads server threads and projects", async () => {
    harness.server.projects.push({
      id: "fixture-project",
      name: "Fixture project",
      roots: [{ path: "/tmp/pesk-e2e-workspace" }],
      metadata: {},
      position: 0,
      createdAt: 1,
      updatedAt: 1,
      recencyAt: null,
    });
    harness.server.threads[0]!.projectId = "fixture-project";
    const app = await harness.launch();
    const chat = await harness.waitForChat(app);
    const trigger = chat.locator(".codex-session-trigger");
    await expect(trigger).toContainText("Fixture thread");
    await trigger.click();
    await expect(chat.locator("#codex-session-menu")).toContainText("Fixture project");
    expect(harness.server.methods).toEqual(
      expect.arrayContaining(["initialize", "thread/list", "project/list"]),
    );
  });

  test("recovers when the configured app-server starts after Electron", async () => {
    const port = harness.server.port;
    await harness.server.close();
    let lateServer: FakeCodexAppServer | undefined;
    const app = await harness.launch();
    const chat = await harness.waitForChat(app);
    await expect(chat.locator(".codex-session-trigger")).toContainText("No active session");
    lateServer = new FakeCodexAppServer({ port });
    await lateServer.ready();
    await expect(chat.locator(".codex-session-trigger")).toContainText("Fixture thread");
    expect(lateServer.methods).toContain("initialize");
    await lateServer?.close();
  });

  test("shows an unavailable-server error without presenting stale sessions", async () => {
    await harness.server.close();
    const app = await harness.launch();
    const chat = await harness.waitForChat(app);
    await expect(chat.locator(".codex-session-trigger")).toContainText("No active session");
    await expect(chat.locator("#codex-error")).toHaveText("Codex connection error.");
  });
});
