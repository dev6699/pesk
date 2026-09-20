import { test, expect } from "playwright/test";
import { fixtureState, WebChatFixture } from "../../fixtures";

test.describe("browser session controls", () => {
  let fixture: WebChatFixture;
  let url: string;

  test.beforeEach(async () => {
    fixture = new WebChatFixture(
      fixtureState("", {
        threadItems: [
          { id: "thread-1", preview: "First session" },
          { id: "thread-2", preview: "Second session" },
        ],
      }),
    );
    url = await fixture.start();
  });

  test.afterEach(async () => fixture.stop());

  test("opens the session picker and selects another session", async ({ page }) => {
    await page.goto(url);
    const trigger = page.locator(".codex-session-trigger");
    await trigger.click();
    await expect(page.locator("#codex-session-menu")).toBeVisible();
    await expect(page.getByRole("option")).toHaveCount(2);
    await page.getByRole("option", { name: "Second session" }).click();
    await expect(trigger).toHaveText("thread-2 — Second session");
    await expect.poll(() => fixture.selectedThread).toBe("thread-2");
  });

  test("supports keyboard session picker navigation and Escape", async ({ page }) => {
    await page.goto(url);
    const trigger = page.locator(".codex-session-trigger");
    await trigger.focus();
    await trigger.press("Enter");
    await expect(trigger).toHaveAttribute("aria-expanded", "true");
    await trigger.press("ArrowDown");
    await trigger.press("Enter");
    await expect(trigger).toHaveText("thread-2 — Second session");
    await trigger.press("Enter");
    await trigger.press("Escape");
    await expect(page.locator("#codex-session-menu")).toBeHidden();
  });

  test("copies the active session identifier", async ({ page }) => {
    await page.goto(url);
    await page.getByRole("button", { name: "Copy session ID" }).click();
    await expect(page.getByRole("button", { name: "Copied" })).toBeVisible();
  });

  test("renames the selected session through the inline form", async ({ page }) => {
    await page.goto(url);
    const input = page.getByRole("textbox", { name: "Message Codex" });
    await input.fill("/rename");
    await page.getByRole("button", { name: "Send" }).click();

    const prompt = page.locator("#codex-user-input[data-rename-thread='true']");
    await expect(prompt).toBeVisible();
    await prompt.getByRole("textbox", { name: "Name" }).fill("Renamed session");
    await prompt.getByRole("button", { name: "Save" }).click();

    await expect(prompt).toBeHidden();
    await expect.poll(() => fixture.lastCommand).toBe("renameThread");
    await page.locator(".codex-session-trigger").click();
    await expect(page.locator("#codex-session-menu")).toContainText("Renamed session");
  });
});
