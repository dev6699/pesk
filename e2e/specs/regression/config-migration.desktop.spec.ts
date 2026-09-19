import { test, expect } from "../../helpers/electron-test";
import { ElectronCodexHarness } from "../../helpers/electron-codex";

test.describe("Electron configuration compatibility", () => {
  let harness: ElectronCodexHarness;

  test.beforeEach(async ({ electronProfile }) => {
    harness = new ElectronCodexHarness(electronProfile);
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
    const chat = await harness.waitForChat(app);
    await expect(chat.locator(".codex-session-trigger")).toContainText("Fixture thread");
  });
});
