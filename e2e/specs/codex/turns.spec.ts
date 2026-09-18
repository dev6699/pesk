import { test, expect } from "playwright/test";
import { fixtureState, WebChatFixture } from "../../fixtures";

test.describe("browser chat lifecycle", () => {
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
        .getByText("Hello from the deterministic Codex fixture.", { exact: true }),
    ).toBeVisible();
    await expect(page.locator("#codex-session-select")).toHaveValue("thread-1");
  });

  test("interrupts a working turn after confirmation", async ({ page }) => {
    await fixture.stop();
    fixture = new WebChatFixture(fixtureState("", { status: "working" }));
    url = await fixture.start();
    await page.goto(url);
    await expect(page.getByRole("button", { name: "Interrupt" })).toBeVisible();
    page.once("dialog", (dialog) => void dialog.accept());
    await page.getByRole("button", { name: "Interrupt" }).click();
    await expect(page.getByRole("button", { name: "Interrupt" })).toBeHidden();
    expect(fixture.lastCommand).toBe("interruptTurn");
    await expect(page.getByText("Conversation interrupted", { exact: true })).toBeVisible();
  });

  test("steers an active turn from the dedicated control", async ({ page }) => {
    await fixture.stop();
    fixture = new WebChatFixture(fixtureState("", { status: "working" }));
    url = await fixture.start();
    await page.goto(url);
    const input = page.getByRole("textbox", { name: "Message Codex" });
    await input.fill("also check the documentation");
    await page.getByRole("button", { name: "Steer the active turn" }).click();
    await expect.poll(() => fixture.lastCommand).toBe("steerTurn");
    expect(fixture.lastSteer).toBe("also check the documentation");
    await expect(input).toHaveValue("");
  });
});
