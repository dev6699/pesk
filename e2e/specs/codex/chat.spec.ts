import { test, expect } from "playwright/test";
import { fixtureState, WebChatFixture } from "../../fixtures";

test.describe("browser chat command flows", () => {
  let fixture: WebChatFixture;
  let url: string;

  test.beforeEach(async () => {
    fixture = new WebChatFixture(fixtureState());
    url = await fixture.start();
  });

  test.afterEach(async () => fixture.stop());

  test("opens and cancels the review prompt", async ({ page }) => {
    await page.goto(url);
    await page.getByRole("textbox", { name: "Message Codex" }).fill("/review");
    await page.getByRole("textbox", { name: "Message Codex" }).press("Escape");
    await page.getByRole("button", { name: "Send" }).click();
    await expect(page.getByRole("textbox", { name: "Review instructions" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Submit review" })).toBeVisible();
    await page.getByRole("button", { name: "Cancel" }).click();
    await expect(page.getByRole("textbox", { name: "Message Codex" })).toBeVisible();
  });

  test("does not submit an empty review prompt", async ({ page }) => {
    await page.goto(url);
    await page.getByRole("textbox", { name: "Message Codex" }).fill("/review");
    await page.getByRole("textbox", { name: "Message Codex" }).press("Escape");
    await page.getByRole("button", { name: "Send" }).click();
    const review = page.getByRole("textbox", { name: "Review instructions" });
    await review.press("Enter");
    await expect(review).toBeVisible();
    await expect(page.locator("#codex-chat-form")).toBeHidden();
  });
});
