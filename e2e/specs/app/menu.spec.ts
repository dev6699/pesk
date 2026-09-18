import { test, expect } from "playwright/test";
import { ElectronCodexHarness } from "../../helpers/electron-codex";

test.describe("Electron menu interactions", () => {
  let harness: ElectronCodexHarness;

  test.beforeEach(async () => {
    harness = new ElectronCodexHarness();
    await harness.start();
  });

  test.afterEach(async () => harness.dispose());

  test("navigates menu sections and changes a control", async () => {
    test.setTimeout(60_000);
    const app = await harness.launch({ ...process.env, PESK_E2E_SHOW_MENU: "1" });
    try {
      const menu = await expect
        .poll(() => app.windows().find((window) => window.url().includes("menu.html")))
        .toBeTruthy()
        .then(() => app.windows().find((window) => window.url().includes("menu.html"))!);
      await menu.waitForLoadState("domcontentloaded");
      await expect(menu.getByRole("heading", { name: "Preset" })).toBeVisible();
      await menu.bringToFront();
      await menu.getByRole("button", { name: "Controls" }).click({ force: true });
      await expect(menu.getByRole("heading", { name: "Controls" })).toBeVisible();
      await expect(menu.getByRole("combobox", { name: "Theme" })).toBeVisible();
      const theme = menu.getByRole("combobox", { name: "Theme" });
      const options = await theme.locator("option").allTextContents();
      if (options.length > 1) {
        await menu.bringToFront();
        await theme.selectOption({ label: options[1] });
        await expect(theme).toHaveValue(/.+/);
      }

      await menu.bringToFront();
      await menu.getByRole("button", { name: "Pairing" }).click({ force: true });
      await expect(menu.getByRole("heading", { name: "Pairing" })).toBeVisible();
      await expect(menu.getByPlaceholder("Device name")).toBeVisible();
      await expect(menu.getByText("No paired devices.", { exact: true })).toBeVisible();
    } finally {
      await app.close();
    }
  });
});
