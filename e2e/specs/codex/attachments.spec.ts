import { test, expect } from "playwright/test";
import { WebChatFixture } from "../../fixtures";

test.describe("browser image attachments", () => {
  let fixture: WebChatFixture;
  let url: string;

  test.beforeEach(async () => {
    fixture = new WebChatFixture();
    url = await fixture.start();
  });

  test.afterEach(async () => fixture.stop());

  test("renders and removes a selected image attachment", async ({ page }) => {
    await page.goto(url);
    await page.locator("#codex-image-input").setInputFiles({
      name: "screenshot.png",
      mimeType: "image/png",
      buffer: Buffer.from("fixture-image"),
    });
    await expect(page.locator("#codex-image-attachments")).toBeVisible();
    await expect(page.getByText("screenshot.png", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Remove screenshot.png" }).click();
    await expect(page.locator("#codex-image-attachments")).toBeHidden();
  });

  test("submits an image-only prompt to the web adapter", async ({ page }) => {
    await page.goto(url);
    await page.locator("#codex-image-input").setInputFiles({
      name: "diagram.jpg",
      mimeType: "image/jpeg",
      buffer: Buffer.from("fixture-image"),
    });
    await page.getByRole("button", { name: "Send" }).click();
    await expect.poll(() => fixture.lastCommand).toBe("submitPrompt");
    expect(fixture.lastPrompt).toBe("");
    expect(fixture.lastImages).toHaveLength(1);
    expect(fixture.lastImages?.[0].name).toBe("diagram.jpg");
    await expect(page.locator("#codex-image-attachments")).toBeHidden();
  });
});
