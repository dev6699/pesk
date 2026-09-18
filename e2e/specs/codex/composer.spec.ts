import { test, expect } from "playwright/test";
import { WebChatFixture } from "../../fixtures";

test.describe("browser composer interactions", () => {
  let fixture: WebChatFixture;
  let url: string;

  test.beforeEach(async () => {
    fixture = new WebChatFixture();
    url = await fixture.start();
  });

  test.afterEach(async () => fixture.stop());

  test("filters and selects a slash-command suggestion", async ({ page }) => {
    await page.goto(url);
    const input = page.getByRole("textbox", { name: "Message Codex" });
    await input.fill("/pla");
    const plan = page.getByRole("option", { name: /\/plan/ });
    await expect(plan).toBeVisible();
    await plan.click();
    await expect(input).toHaveValue("/plan ");
    await expect(page.locator("#codex-command-mode")).toBeHidden();
  });

  test("shows the correct execution mode for shell and sandbox commands", async ({ page }) => {
    await page.goto(url);
    const input = page.getByRole("textbox", { name: "Message Codex" });
    const mode = page.locator("#codex-command-mode");

    await input.fill("!echo hello");
    await expect(mode).toHaveText("Shell · full access");
    await expect(mode).toHaveAttribute("data-mode", "shell");

    await input.fill("/exec echo hello");
    await expect(mode).toHaveText("Exec · sandboxed");
    await expect(mode).toHaveAttribute("data-mode", "exec");

    await input.fill("hello");
    await expect(mode).toBeHidden();
  });

  test("uses Enter for a newline in the web composer", async ({ page }) => {
    await page.goto(url);
    const input = page.getByRole("textbox", { name: "Message Codex" });
    await input.fill("first line");
    await input.press("Enter");
    await expect(input).toHaveValue("first line\n");
    expect(fixture.lastCommand).toBeUndefined();
  });

  test("recalls the last submitted prompt with ArrowUp", async ({ page }) => {
    await page.goto(url);
    const input = page.getByRole("textbox", { name: "Message Codex" });
    await input.fill("remember this prompt");
    await page.getByRole("button", { name: "Send" }).click();
    await expect.poll(() => fixture.lastCommand).toBe("submitPrompt");
    await expect(input).toHaveValue("");
    await input.focus();
    await input.press("ArrowUp");
    await expect(input).toHaveValue("remember this prompt");
  });

  test("selects a fuzzy file suggestion for an @ reference", async ({ page }) => {
    await fixture.stop();
    fixture = new WebChatFixture(undefined, {}, [
      {
        file_name: "app.ts",
        path: "src/app.ts",
        root: "src",
        match_type: "file",
        score: 1,
        indices: [0],
      },
    ]);
    url = await fixture.start();
    await page.goto(url);
    const input = page.getByRole("textbox", { name: "Message Codex" });
    await input.fill("@app");
    await expect(page.getByRole("option", { name: /app\.ts/ })).toBeVisible();
    await page.getByRole("option", { name: /app\.ts/ }).click();
    await expect(input).toHaveValue("src/app.ts ");
  });

  test("navigates and dismisses slash-command suggestions with the keyboard", async ({ page }) => {
    await page.goto(url);
    const input = page.getByRole("textbox", { name: "Message Codex" });
    await input.fill("/p");
    await expect(page.getByRole("option")).toHaveCount(2);
    await input.press("ArrowDown");
    await input.press("Escape");
    await expect(page.locator("#codex-file-suggestions")).toBeHidden();
    await expect(input).toHaveValue("/p");
  });
});
