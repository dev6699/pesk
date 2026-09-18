import { test, expect } from "playwright/test";
import { WebChatFixture } from "./web-fixture";

test.describe("browser chat", () => {
  let fixture: WebChatFixture;
  let url: string;

  test.beforeEach(async () => {
    fixture = new WebChatFixture();
    url = await fixture.start();
  });

  test.afterEach(async () => fixture.stop());

  test("connects, sends a prompt, and renders the response", async ({ page }) => {
    await page.goto(url);
    await expect(page.locator("#web-connection-status")).toHaveText("Connected");
    await expect(page.getByRole("textbox", { name: "Message Codex" })).toBeFocused();

    await page.getByRole("textbox", { name: "Message Codex" }).fill("hello");
    await page.getByRole("button", { name: "Send" }).click();

    await expect(
      page
        .locator("#codex-history-content")
        .getByText("Hello from the deterministic Codex fixture.", {
          exact: true,
        }),
    ).toBeVisible();
    await expect(page.locator("#codex-session-select")).toHaveValue("thread-1");
  });

  test("shows a reconnecting state when the web socket closes", async ({ page }) => {
    await page.goto(url);
    await expect(page.locator("#web-connection-status")).toHaveText("Connected");
    await page.evaluate(() => window.dispatchEvent(new Event("offline")));
    for (const socket of fixture.sockets) socket.close();
    await expect(page.locator("#web-connection-status")).toHaveText(/Reconnecting|Connecting/);
  });
});
