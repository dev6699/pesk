import { test, expect } from "../../helpers/electron-test";
import { ElectronCodexHarness } from "../../helpers/electron-codex";

test.describe("Electron desktop controls", () => {
  let harness: ElectronCodexHarness;

  test.beforeEach(async ({ electronProfile }) => {
    harness = new ElectronCodexHarness(electronProfile);
    await harness.start();
  });

  test.afterEach(async () => harness.dispose());

  test("toggles the desktop chat lock control", async () => {
    const app = await harness.launch();
    const chat = await harness.waitForChat(app);
    const lock = chat.locator("#codex-chat-lock");
    await expect(lock).toHaveAttribute("aria-label", "Lock chat window");
    await lock.click();
    await expect(lock).toHaveAttribute("aria-label", "Unlock chat window");
    await lock.click();
    await expect(lock).toHaveAttribute("aria-label", "Lock chat window");
  });
});
