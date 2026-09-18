import { test, expect } from "playwright/test";
import { createServer } from "node:net";
import { ElectronCodexHarness } from "../../helpers/electron-codex";

async function freePort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((resolve, reject) => {
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => resolve());
  });
  const address = probe.address();
  if (!address || typeof address === "string") {
    probe.close();
    throw new Error("Could not determine a free E2E web port");
  }
  const port = address.port;
  await new Promise<void>((resolve, reject) =>
    probe.close((error) => (error ? reject(error) : resolve())),
  );
  return port;
}

test.describe("paired browser Codex workflows", () => {
  let harness: ElectronCodexHarness;
  let webPort: number;

  test.beforeEach(async () => {
    harness = new ElectronCodexHarness();
    await harness.start();
    webPort = await freePort();
    harness.writeConfig({ webAccessEnabled: true, webPort });
  });

  test.afterEach(async () => harness.dispose());

  test("approves an app-server request from the paired browser", async ({ browser }) => {
    harness.server.enableApproval();
    const app = await harness.launch({ ...process.env, PESK_E2E_SHOW_MENU: "1" });
    const page = await browser.newPage();
    try {
      const menu = await harness.waitForMenu(app);
      const pairing = await menu.evaluate(() => window.peskApi.createPairing("E2E approval"));
      if (!pairing) throw new Error("Pairing was not created");
      const pairingCode = new URL(pairing.urls[0] ?? "").searchParams.get("code");
      if (!pairingCode) throw new Error("Pairing URL did not contain a code");

      await page.goto(`http://127.0.0.1:${webPort}/pair?code=${encodeURIComponent(pairingCode)}`);
      await expect(page.locator("#web-connection-status")).toHaveText("Connected", {
        timeout: 10_000,
      });
      const input = page.getByRole("textbox", { name: "Message Codex" });
      await input.fill("approve this remotely");
      await page.getByRole("button", { name: "Send" }).click();

      const approval = page.locator("#codex-user-input");
      await expect(approval).toContainText("echo approval-required", { timeout: 10_000 });
      await approval.getByRole("radio", { name: /Approve once/ }).check();
      await approval.getByRole("button", { name: "Submit" }).click();
      await expect(page.locator("#codex-history-content")).toContainText(
        "Hello from fake Codex app-server.",
        { timeout: 10_000 },
      );
      expect(harness.server.permissionResponses).toEqual([{ decision: "accept" }]);
    } finally {
      await page.close();
      await app.close();
    }
  });
});
