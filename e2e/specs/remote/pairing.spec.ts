import { test, expect } from "playwright/test";
import { WebChatFixture } from "../../fixtures";

test.describe("browser pairing and multi-client sync", () => {
  let fixture: WebChatFixture;
  let url: string;

  test.beforeEach(async () => {
    fixture = new WebChatFixture();
    url = await fixture.start();
  });

  test.afterEach(async () => fixture.stop());

  test("exchanges a pairing code before connecting", async ({ page }) => {
    await page.goto(`${url}?code=PAIR-ME`);
    await expect(page.locator("#web-connection-status")).toHaveText("Connected");
    await expect(page).toHaveURL(url);
    await expect
      .poll(() => page.evaluate(() => localStorage.getItem("pesk-device-credential")))
      .toBe("fixture-credential");
  });

  test("synchronizes a prompt response across browser clients", async ({ browser, page }) => {
    const secondPage = await browser.newPage();
    await Promise.all([page.goto(url), secondPage.goto(url)]);
    await expect(secondPage.locator("#web-connection-status")).toHaveText("Connected");
    await page.getByRole("textbox", { name: "Message Codex" }).fill("hello from client one");
    await page.getByRole("button", { name: "Send" }).click();
    const response = "Hello from the deterministic Codex fixture.";
    await expect(
      page.locator("#codex-history-content").getByText(response, { exact: true }),
    ).toBeVisible();
    await expect(
      secondPage.locator("#codex-history-content").getByText(response, { exact: true }),
    ).toBeVisible();
    await secondPage.close();
  });
});
