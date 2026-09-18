import { _electron as electron } from "playwright";
import { test, expect } from "playwright/test";
import * as path from "node:path";

test.describe("Electron desktop shell", () => {
  test("launches the pet and opens the chat window", async () => {
    const app = await electron.launch({
      args: [path.resolve(process.env.PESK_BUILD_DIR || "build", "main.js")],
      executablePath: process.env.PESK_ELECTRON_EXECUTABLE,
    });
    try {
      const pet = await expect
        .poll(() => app.windows().find((window) => window.url().includes("pet.html")))
        .toBeTruthy()
        .then(() => app.windows().find((window) => window.url().includes("pet.html"))!);
      await expect(pet.locator("#pet")).toBeVisible();
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
