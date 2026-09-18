import { test, expect } from "playwright/test";
import { ElectronCodexHarness } from "../../helpers/electron-codex";

test.describe("Electron desktop shell", () => {
  let harness: ElectronCodexHarness;

  test.beforeEach(async () => {
    harness = new ElectronCodexHarness();
    await harness.start();
  });

  test.afterEach(async () => harness.dispose());

  test("launches the pet and opens the chat window", async () => {
    const app = await harness.launch();
    try {
      const pet = await expect
        .poll(() => app.windows().find((window) => window.url().includes("pet.html")))
        .toBeTruthy()
        .then(() => app.windows().find((window) => window.url().includes("pet.html"))!);
      await expect(pet.locator("#pet")).toBeVisible();
      await expect(pet.locator("#pet-image")).toBeVisible();
      const chat = await expect
        .poll(() => app.windows().find((window) => window.url().includes("chat.html")))
        .toBeTruthy()
        .then(() => app.windows().find((window) => window.url().includes("chat.html"))!);
      await expect(chat.locator("#codex-chat")).toBeVisible();
      await expect(chat.getByRole("textbox", { name: "Message Codex" })).toBeVisible();
    } finally {
      await app.close();
    }
  });
});
