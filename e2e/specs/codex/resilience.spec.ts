import { test, expect } from "playwright/test";
import { fixtureState, WebChatFixture } from "../../fixtures";

test.describe("browser UI resilience", () => {
  let fixture: WebChatFixture;
  let url: string;

  test.beforeEach(async () => {
    fixture = new WebChatFixture(
      fixtureState("A long response ".repeat(80), {
        threadItems: [
          {
            id: "long-thread",
            preview: "Long thread title ".repeat(20),
          },
        ],
      }),
    );
    url = await fixture.start();
  });

  test.afterEach(async () => fixture.stop());

  test("keeps long titles and streamed content usable at a narrow viewport", async ({ page }) => {
    await page.setViewportSize({ width: 360, height: 640 });
    await page.goto(url);
    await expect(page.locator(".codex-session-trigger")).toContainText("Long thread title");
    await expect(page.locator("#codex-history-content")).toContainText("A long response");
    await expect(page.getByRole("textbox", { name: "Message Codex" })).toBeVisible();
  });

  test("reconnects and restores the selected session after a renderer reload", async ({ page }) => {
    await page.goto(url);
    await expect(page.locator("#web-connection-status")).toHaveText("Connected");
    await expect(page.locator(".codex-session-trigger")).toContainText("Long thread title");
    await page.reload();
    await expect(page.locator("#web-connection-status")).toHaveText("Connected", {
      timeout: 5_000,
    });
    await expect(page.locator(".codex-session-trigger")).toContainText("Long thread title");
  });
});
