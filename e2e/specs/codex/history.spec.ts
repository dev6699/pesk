import { test, expect } from "playwright/test";
import { fixtureState, WebChatFixture } from "../../fixtures";

test.describe("browser rendered history", () => {
  let fixture: WebChatFixture;
  let url: string;

  test.beforeEach(async () => {
    fixture = new WebChatFixture(
      fixtureState("", {
        messages: [
          { role: "user", text: "Show the result" },
          {
            role: "assistant",
            text: [
              "Read [the docs](https://example.test/docs)",
              "See [Project client](</mnt/c/Pesk Workspace/projects.ts:79>)",
              "```bash\necho hello\n```",
            ].join("\n\n"),
            images: [{ name: "result.png", url: "data:image/png;base64,AAAA" }],
          },
        ],
      }),
    );
    url = await fixture.start();
  });

  test.afterEach(async () => fixture.stop());

  test("renders Markdown links, code-copy controls, and attached images", async ({ page }) => {
    await page.goto(url);
    await expect(page.getByRole("link", { name: "the docs" })).toHaveAttribute(
      "href",
      "https://example.test/docs",
    );
    await expect(page.getByRole("img", { name: "Attached image: result.png" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Copy code" })).toBeVisible();
  });

  test("copies a rendered shell command and reports completion", async ({ page }) => {
    await page.goto(url);
    await page.getByRole("button", { name: "Copy code" }).click();
    await expect(page.getByRole("button", { name: "Copied" })).toBeVisible();
  });

  test("copies a Markdown file path with its line number", async ({ context, page }) => {
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    await page.goto(url);
    const pathButton = page.getByRole("button", { name: "Project client" });
    await pathButton.click();
    const confirmation = page.getByText("Path copied", { exact: true });
    await expect(confirmation).toBeVisible();
    await expect
      .poll(() => page.evaluate(() => navigator.clipboard.readText()))
      .toBe("/mnt/c/Pesk Workspace/projects.ts:79");
    await expect(confirmation).toBeHidden();
  });
});
