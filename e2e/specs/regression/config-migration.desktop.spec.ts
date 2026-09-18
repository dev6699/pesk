import { test, expect } from "playwright/test";
import { ElectronCodexHarness } from "../../helpers/electron-codex";

test.describe("Electron configuration compatibility", () => {
  let harness: ElectronCodexHarness;

  test.beforeEach(async () => {
    harness = new ElectronCodexHarness();
    await harness.start();
  });

  test.afterEach(async () => harness.dispose());

  test("falls back to the first valid profile when the active profile is unknown", async () => {
    harness.writeConfig({
      codexAppServerProfiles: [
        { id: "malformed", name: "Malformed", url: "not-a-websocket" },
        { id: "fixture", name: "Fixture", url: harness.server.url },
      ],
      unknownFutureField: "ignored",
    });
    const app = await harness.launch();
    try {
      const chat = await harness.waitForChat(app);
      await expect(chat.locator(".codex-session-trigger")).toContainText("Fixture thread", {
        timeout: 10_000,
      });
    } finally {
      await app.close();
    }
  });

  test("starts safely when profiles are malformed and a legacy URL is present", async () => {
    harness.writeConfig({
      codexAppServerProfiles: [{ id: "invalid", name: "Invalid", url: "http://not-websocket" }],
      activeCodexAppServerProfileId: "invalid",
      codexAppServerUrl: harness.server.url,
    });
    const app = await harness.launch();
    try {
      const chat = await harness.waitForChat(app);
      await expect.poll(() => harness.server.methods).not.toContain("initialize");
      await expect(chat.locator(".codex-session-trigger")).not.toContainText("Fixture thread");
    } finally {
      await app.close();
    }
  });

  test("starts with defaults when the profile list is empty", async () => {
    harness.writeConfig({
      codexAppServerProfiles: [],
      activeCodexAppServerProfileId: "missing",
    });
    const app = await harness.launch();
    try {
      await expect
        .poll(() => app.windows().some((window) => window.url().includes("chat.html")))
        .toBe(true);
      expect(harness.server.methods).not.toContain("initialize");
    } finally {
      await app.close();
    }
  });
});
