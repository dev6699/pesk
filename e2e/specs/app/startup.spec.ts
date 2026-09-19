import { test, expect } from "../../helpers/electron-test";
import { ElectronCodexHarness } from "../../helpers/electron-codex";

test.describe("Electron desktop shell", () => {
  let harness: ElectronCodexHarness;

  test.beforeEach(async ({ electronProfile }) => {
    harness = new ElectronCodexHarness(electronProfile);
    await harness.start();
  });

  test.afterEach(async () => harness.dispose());

  test("launches the pet and opens the chat window", async () => {
    const app = await harness.launch();
    const pet = await harness.waitForWindow(app, "pet.html");
    await expect(pet.locator("#pet")).toBeVisible();
    await expect(pet.locator("#pet-image")).toBeVisible();
    const chat = await harness.waitForChat(app);
    await expect(chat.locator("#codex-chat")).toBeVisible();
    await expect(chat.getByRole("textbox", { name: "Message Codex" })).toBeVisible();
  });
});
