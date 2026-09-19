import { test, expect } from "../../helpers/electron-test";
import { ElectronCodexHarness } from "../../helpers/electron-codex";

test.describe("Electron menu interactions", () => {
  let harness: ElectronCodexHarness;

  test.beforeEach(async ({ electronProfile }) => {
    harness = new ElectronCodexHarness(electronProfile);
    await harness.start();
  });

  test.afterEach(async () => harness.dispose());

  test("navigates menu sections and changes a control", async () => {
    const app = await harness.launch({ ...process.env, PESK_E2E_SHOW_MENU: "1" });
    const menu = await harness.waitForMenu(app);
    await expect(menu.getByRole("heading", { name: "Preset" })).toBeVisible();
    await harness.focusWindow(app, menu);
    await menu.getByRole("button", { name: "Controls" }).click();
    await expect(menu.getByRole("heading", { name: "Controls" })).toBeVisible();
    await expect(menu.getByRole("combobox", { name: "Theme" })).toBeVisible();
    const theme = menu.getByRole("combobox", { name: "Theme" });
    const options = await theme.locator("option").allTextContents();
    console.log("11");
    if (options.length > 1) {
      await harness.focusWindow(app, menu);
      await theme.selectOption({ label: options[1] });
      await expect(theme).toHaveValue(/.+/);
    }

    await harness.focusWindow(app, menu);
    await menu.getByRole("button", { name: "Pairing" }).click();
    await expect(menu.getByRole("heading", { name: "Pairing" })).toBeVisible();
    await expect(menu.getByPlaceholder("Device name")).toBeVisible();
    await expect(menu.getByText("No paired devices.", { exact: true })).toBeVisible();
  });
});
