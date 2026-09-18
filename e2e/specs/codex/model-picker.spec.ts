import { test, expect } from "playwright/test";
import { fixtureState, WebChatFixture } from "../../fixtures";

const models = [
  {
    model: "gpt-test",
    displayName: "GPT Test",
    description: "Fast test model",
    supportedReasoningEfforts: [
      { reasoningEffort: "low", description: "Quick answers" },
      { reasoningEffort: "high", description: "Deeper reasoning" },
    ],
    defaultReasoningEffort: "low",
    isDefault: true,
  },
  {
    model: "gpt-pro",
    displayName: "GPT Pro",
    description: "More capable test model",
    supportedReasoningEfforts: [{ reasoningEffort: "high", description: "Deep reasoning" }],
    defaultReasoningEffort: "high",
    isDefault: false,
  },
];

test.describe("browser model picker", () => {
  let fixture: WebChatFixture;
  let url: string;

  test.beforeEach(async () => {
    fixture = new WebChatFixture(fixtureState("", { modelPicker: { stage: "model", models } }));
    url = await fixture.start();
  });

  test.afterEach(async () => fixture.stop());

  test("selects a model and reasoning effort in two steps", async ({ page }) => {
    await page.goto(url);
    await expect(page.getByText("Select Model and Effort", { exact: true })).toBeVisible();
    await page.getByRole("radio", { name: /GPT Pro/ }).check();
    await page.getByRole("button", { name: "Next" }).click();
    await expect(
      page.getByText("Select Reasoning Level for gpt-pro", { exact: true }),
    ).toBeVisible();
    await page.getByRole("radio", { name: /Deep reasoning/ }).check();
    await page.getByRole("button", { name: "Apply" }).click();
    await expect.poll(() => fixture.lastModel).toEqual({ model: "gpt-pro", effort: "high" });
    await expect(
      page.getByText("Select Reasoning Level for gpt-pro", { exact: true }),
    ).toBeHidden();
  });

  test("cancels model selection with Escape", async ({ page }) => {
    await page.goto(url);
    await page.keyboard.press("Escape");
    await expect.poll(() => fixture.lastCommand).toBe("cancelModel");
    await expect(page.getByText("Select Model and Effort", { exact: true })).toBeHidden();
  });
});
