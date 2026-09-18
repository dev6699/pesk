import { test, expect } from "playwright/test";
import { fixtureState, WebChatFixture } from "../../fixtures";

test.describe("browser approvals and user input", () => {
  let fixture: WebChatFixture;
  let url: string;

  test.afterEach(async () => fixture?.stop());

  test("submits a pending approval decision", async ({ page }) => {
    fixture = new WebChatFixture(
      fixtureState("", {
        pendingApproval: {
          requestId: "approval-1",
          command: "npm test",
          reason: "Run the test suite",
          options: [
            { id: "accept", label: "Allow", description: "Run this command" },
            { id: "deny", label: "Deny", description: "Block this command" },
          ],
        },
      }),
    );
    url = await fixture.start();
    await page.goto(url);
    await expect(page.getByText("npm test", { exact: true })).toBeVisible();
    await page.getByRole("radio", { name: /Allow/ }).check();
    await page.getByRole("button", { name: "Submit" }).click();
    expect(fixture.lastPermission).toEqual({ requestId: "approval-1", optionId: "accept" });
  });

  test("submits a denial for a pending approval", async ({ page }) => {
    fixture = new WebChatFixture(
      fixtureState("", {
        pendingApproval: {
          requestId: "approval-deny",
          command: "rm -rf build",
          reason: "Remove generated files",
          options: [
            { id: "accept", label: "Allow", description: "Run this command" },
            { id: "deny", label: "Deny", description: "Block this command" },
          ],
        },
      }),
    );
    url = await fixture.start();
    await page.goto(url);
    await page.getByRole("radio", { name: /Deny/ }).check();
    await page.getByRole("button", { name: "Submit" }).click();
    expect(fixture.lastPermission).toEqual({ requestId: "approval-deny", optionId: "deny" });
  });

  test("submits pending user input", async ({ page }) => {
    fixture = new WebChatFixture(
      fixtureState("", {
        pendingUserInput: {
          requestId: "question-1",
          threadId: "thread-1",
          turnId: "turn-1",
          itemId: "item-1",
          questions: [
            {
              id: "choice",
              header: "Environment",
              question: "Which environment?",
              isOther: false,
              isSecret: false,
              options: [{ label: "Test", description: "Use the test environment" }],
            },
          ],
          isBlocking: true,
        },
      }),
    );
    url = await fixture.start();
    await page.goto(url);
    await page.getByRole("radio", { name: /Test/ }).check();
    await page.getByRole("button", { name: "Submit" }).click();
    expect(fixture.lastUserInput).toEqual({
      requestId: "question-1",
      answers: { choice: ["Test"] },
    });
  });

  test("advances through multiple questions and submits free-form input", async ({ page }) => {
    fixture = new WebChatFixture(
      fixtureState("", {
        pendingUserInput: {
          requestId: "question-multi",
          threadId: "thread-1",
          turnId: "turn-1",
          itemId: "item-1",
          questions: [
            {
              id: "environment",
              header: "Environment",
              question: "Which environment?",
              isOther: false,
              isSecret: false,
              options: [{ label: "Test", description: "Use the test environment" }],
            },
            {
              id: "details",
              header: "Details",
              question: "Provide details",
              isOther: true,
              isSecret: true,
              options: [],
            },
          ],
          isBlocking: true,
        },
      }),
    );
    url = await fixture.start();
    await page.goto(url);
    await page.getByRole("radio", { name: /Test/ }).check();
    await page.getByRole("button", { name: "Next" }).click();
    const details = page.getByPlaceholder("Other");
    await expect(details).toHaveAttribute("type", "password");
    await details.fill("secret details");
    await page.getByRole("button", { name: "Submit" }).click();
    expect(fixture.lastUserInput).toEqual({
      requestId: "question-multi",
      answers: { environment: ["Test"], details: ["secret details"] },
    });
  });
});
