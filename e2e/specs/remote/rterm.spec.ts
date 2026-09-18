import { test, expect } from "playwright/test";
import { fixtureState, WebChatFixture } from "../../fixtures";

test.describe("browser remote terminal", () => {
  let fixture: WebChatFixture;
  let url: string;

  test.beforeEach(async () => {
    fixture = new WebChatFixture(fixtureState("", { remoteTerminal: true }));
    url = await fixture.start();
  });

  test.afterEach(async () => fixture.stop());

  test("opens and closes the remote terminal panel", async ({ page }) => {
    await page.goto(url);
    const input = page.getByRole("textbox", { name: "Message Codex" });
    await input.fill("/rterm");
    await page.getByRole("button", { name: "Send" }).click();
    await expect(page.locator("#rterm-panel")).toBeVisible();
    await expect(page.locator("#rterm-frame")).toHaveAttribute("src", /rterm-proxy\/embed/);
    await expect(page.locator("#codex-chat")).not.toHaveClass(/rterm-side-layout/);
    await page.getByRole("button", { name: "Move remote terminal to the right side" }).click();
    await expect(page.locator("#codex-chat")).toHaveClass(/rterm-side-layout/);
    await expect(
      page.getByRole("button", { name: "Move remote terminal below the chat" }),
    ).toBeVisible();
    await page.getByRole("button", { name: "Refresh remote terminal" }).click();
    await expect(page.locator("#rterm-frame")).toHaveAttribute("src", /rterm-proxy\/embed/);
    await page.getByRole("button", { name: "Minimize remote terminal" }).click();
    await expect(page.locator("#rterm-panel")).toBeHidden();
  });
});
