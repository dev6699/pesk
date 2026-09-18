import { test, expect } from "playwright/test";
import { fixtureState, WebChatFixture } from "../../fixtures";

test.describe("browser project management flows", () => {
  let fixture: WebChatFixture;
  let url: string;

  test.beforeEach(async () => {
    fixture = new WebChatFixture(fixtureState());
    url = await fixture.start();
  });

  test.afterEach(async () => fixture.stop());

  test("opens and cancels the project manager", async ({ page }) => {
    await page.goto(url);
    await page.getByRole("textbox", { name: "Message Codex" }).fill("/project");
    await page.getByRole("button", { name: "Send" }).click();
    await expect(page.locator("#codex-user-input[data-project-manager='true']")).toBeVisible();
    await expect(page.getByText("Project manager", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Cancel" }).click();
    await expect(page.getByRole("textbox", { name: "Message Codex" })).toBeVisible();
  });

  test("shows the no-project state for a new project thread", async ({ page }) => {
    await page.goto(url);
    await page.getByRole("textbox", { name: "Message Codex" }).fill("/new");
    await page.getByRole("button", { name: "Send" }).click();
    await expect(page.locator("#codex-user-input[data-project-thread='true']")).toBeVisible();
    await expect(page.getByText("No projects are available.", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Cancel" }).click();
    await expect(page.getByRole("textbox", { name: "Message Codex" })).toBeVisible();
  });

  test("starts a new thread from a selected project root", async ({ page }) => {
    await fixture.stop();
    fixture = new WebChatFixture(
      fixtureState("", {
        projects: [
          {
            id: "project-1",
            name: "Workspace",
            roots: [{ path: "/workspace" }],
            metadata: {},
            position: 0,
            createdAt: 1,
            updatedAt: 1,
            recencyAt: null,
          },
        ],
      }),
    );
    url = await fixture.start();
    await page.goto(url);
    await page.getByRole("textbox", { name: "Message Codex" }).fill("/new");
    await page.getByRole("button", { name: "Send" }).click();
    await page.locator("select[aria-label='Project']").selectOption("project-1");
    await expect(page.locator("select[aria-label='Thread root']")).toHaveValue("/workspace");
    await page.getByRole("button", { name: "Continue" }).click();
    await expect.poll(() => fixture.lastCommand).toBe("startProjectThread");
    expect(fixture.selectedThread).toBe("thread-project-2");
  });

  test("creates a project through the project manager", async ({ page }) => {
    await page.goto(url);
    await page.getByRole("textbox", { name: "Message Codex" }).fill("/project");
    await page.getByRole("button", { name: "Send" }).click();
    await page.getByRole("textbox", { name: "Name" }).fill("Workspace");
    await page.getByRole("textbox", { name: "Root" }).fill("/workspace");
    await page.getByRole("button", { name: "Continue" }).click();
    await expect(page.getByText("Project created successfully.", { exact: true })).toBeVisible();
    await expect(page.locator("select[aria-label='Project']")).toHaveValue("project-1");
    expect(fixture.lastCommand).toBe("listProjects");
  });

  test("updates roots and confirms project deletion", async ({ page }) => {
    await fixture.stop();
    fixture = new WebChatFixture(
      fixtureState("", {
        projects: [
          {
            id: "project-1",
            name: "Workspace",
            roots: [{ path: "/workspace" }, { path: "/workspace/docs" }],
            metadata: {},
            position: 0,
            createdAt: 1,
            updatedAt: 1,
            recencyAt: null,
          },
          {
            id: "project-2",
            name: "Archive",
            roots: [{ path: "/archive" }],
            metadata: {},
            position: 1,
            createdAt: 1,
            updatedAt: 1,
            recencyAt: null,
          },
        ],
      }),
    );
    url = await fixture.start();
    await page.goto(url);
    await page.getByRole("textbox", { name: "Message Codex" }).fill("/project");
    await page.getByRole("button", { name: "Send" }).click();

    const action = page.getByRole("combobox", { name: "Project action" });
    await action.selectOption("rename");
    await page.getByRole("textbox", { name: "Name" }).fill("Renamed");
    await page.getByRole("button", { name: "Continue" }).click();
    await expect(page.getByText("Project updated successfully.", { exact: true })).toBeVisible();

    await action.selectOption("add-root");
    await page.getByRole("textbox", { name: "Root" }).fill("/workspace/src");
    await page.getByRole("button", { name: "Continue" }).click();
    await expect(page.getByRole("list").getByText("/workspace/src", { exact: true })).toBeVisible();

    await action.selectOption("remove-root");
    await page.getByRole("combobox", { name: "Root to remove" }).selectOption("/workspace/docs");
    await page.getByRole("button", { name: "Continue" }).click();
    await expect(page.getByRole("list").getByText("/workspace/docs", { exact: true })).toBeHidden();

    await page.locator("select[aria-label='Project']").selectOption("project-1");
    await action.selectOption("move");
    await page.getByRole("spinbutton", { name: "Position" }).fill("2");
    await page.getByRole("button", { name: "Continue" }).click();
    await expect(page.getByText("Project moved successfully.", { exact: true })).toBeVisible();

    await page.locator("select[aria-label='Project']").selectOption("project-2");
    await action.selectOption("delete");
    await page.getByRole("button", { name: "Continue" }).click();
    await expect(page.getByText(/Delete Archive\?/)).toBeVisible();
    await page.getByRole("button", { name: "Confirm delete" }).click();
    await expect(page.getByText("Project deleted successfully.", { exact: true })).toBeVisible();
    await expect(page.locator("select[aria-label='Project']")).not.toHaveValue("project-2");
  });
});
