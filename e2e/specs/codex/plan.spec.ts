import { test, expect } from "playwright/test";
import { fixtureState, WebChatFixture } from "../../fixtures";

const planMessages = [
  {
    role: "assistant" as const,
    text: "Plan complete",
    activity: {
      kind: "plan" as const,
      status: "completed",
      details: "1. Add tests\n2. Run the suite",
    },
  },
];

test.describe("browser completed-plan confirmation", () => {
  let fixture: WebChatFixture;
  let url: string;

  test.beforeEach(async () => {
    fixture = new WebChatFixture(fixtureState("", { messages: planMessages }));
    url = await fixture.start();
  });

  test.afterEach(async () => fixture.stop());

  test("stays in Plan mode without implementing", async ({ page }) => {
    await page.goto(url);
    await expect(page.getByText("Implement this plan?", { exact: true })).toBeVisible();
    await page.getByRole("radio", { name: /No, stay in Plan mode/ }).check();
    await page.getByRole("button", { name: "Submit" }).click();
    await expect(page.getByText("Implement this plan?", { exact: true })).toBeHidden();
    await expect(page.getByRole("textbox", { name: "Message Codex" })).toBeVisible();
    expect(fixture.lastCommand).toBeUndefined();
  });

  test("implements the completed plan with a fresh context", async ({ page }) => {
    await page.goto(url);
    await page.getByRole("radio", { name: /Yes, clear context and implement/ }).check();
    await page.getByRole("button", { name: "Submit" }).click();
    await expect
      .poll(() => fixture.lastPlanImplementation)
      .toEqual({
        planText: "1. Add tests\n2. Run the suite",
        clearContext: true,
      });
  });
});
