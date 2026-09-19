import { test, expect } from "../../helpers/electron-test";
import { ElectronCodexHarness } from "../../helpers/electron-codex";
import { FakeCodexAppServer } from "../../servers/fake-codex/server";

test.describe("Electron reconnect behavior", () => {
  let harness: ElectronCodexHarness;

  test.beforeEach(async ({ electronProfile }) => {
    harness = new ElectronCodexHarness(electronProfile);
    await harness.start();
  });

  test.afterEach(async () => harness.dispose());

  test("reconnects after the app-server restarts without retaining stale state", async () => {
    harness.server.projects.push({
      id: "old-project",
      name: "Old project",
      roots: [{ path: "/tmp/old" }],
      metadata: {},
      position: 0,
      createdAt: 1,
      updatedAt: 1,
      recencyAt: null,
    });
    harness.server.threads[0]!.projectId = "old-project";
    const port = harness.server.port;
    const app = await harness.launch();
    let restarted: FakeCodexAppServer | undefined;
    const chat = await harness.waitForChat(app);
    const sessions = chat.locator(".codex-session-trigger");
    await expect(sessions).toContainText("Fixture thread");
    await sessions.click();
    await expect(chat.locator("#codex-session-menu")).toContainText("Old project");

    await harness.server.close();
    await expect(sessions).toContainText("No active session");
    await expect(chat.locator("#codex-session-menu")).not.toContainText("Old project");

    restarted = new FakeCodexAppServer({
      port,
      threads: [
        {
          id: "restarted-thread",
          preview: "Restarted thread",
          cwd: "/tmp/restarted",
          projectId: "restarted-project",
        },
      ],
      projects: [
        {
          id: "restarted-project",
          name: "Restarted project",
          roots: [{ path: "/tmp/restarted" }],
          metadata: {},
          position: 0,
          createdAt: 2,
          updatedAt: 2,
          recencyAt: null,
        },
      ],
    });
    await restarted.ready();
    await expect(sessions).toContainText("Restarted thread");
    await sessions.click();
    await expect(chat.locator("#codex-session-menu")).toContainText("Restarted project");
    await expect(chat.locator("#codex-session-menu")).not.toContainText("Old project");
    await restarted?.close();
  });
});
