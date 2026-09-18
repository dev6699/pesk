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

test.describe("paired browser web client", () => {
  let harness: ElectronCodexHarness;
  let webPort: number;

  test.beforeEach(async () => {
    harness = new ElectronCodexHarness();
    await harness.start();
    webPort = await freePort();
    harness.writeConfig({ webAccessEnabled: true, webPort });
  });

  test.afterEach(async () => harness.dispose());

  test("pairs an authorized browser, loads threads, and streams a prompt response", async ({
    browser,
  }) => {
    harness.server.threads.push({
      id: "remote-thread-2",
      preview: "Remote second thread",
      cwd: "/tmp/pesk-e2e-workspace",
      projectId: null,
    });
    const app = await harness.launch({ ...process.env, PESK_E2E_SHOW_MENU: "1" });
    const page = await browser.newPage();
    try {
      const chat = await harness.waitForChat(app);
      await expect(chat.locator(".codex-session-trigger")).toContainText("Fixture thread", {
        timeout: 10_000,
      });
      const menu = await harness.waitForMenu(app);
      const pairing = await menu.evaluate(() => window.peskApi.createPairing("E2E browser"));
      if (!pairing) throw new Error("Pairing was not created");
      const pairingCode = new URL(pairing.urls[0] ?? "").searchParams.get("code");
      if (!pairingCode) throw new Error("Pairing URL did not contain a code");

      await page.goto(`http://127.0.0.1:${webPort}/pair?code=${encodeURIComponent(pairingCode)}`);
      await expect(page.locator("#web-connection-status")).toHaveText("Connected", {
        timeout: 10_000,
      });
      await expect(page.locator(".codex-session-trigger")).toContainText("Fixture thread");
      await page.locator(".codex-session-trigger").click();
      const secondThread = page
        .locator("#codex-session-menu")
        .getByRole("option", { name: /Remote second thread/ });
      await expect(secondThread).toBeVisible();
      await secondThread.click({ force: true });
      await expect(page.locator(".codex-session-trigger")).toContainText("Remote second thread");

      const input = page.getByRole("textbox", { name: "Message Codex" });
      await input.fill("hello from the paired browser");
      await page.getByRole("button", { name: "Send" }).click();
      await expect(page.locator(".codex-message-user")).toContainText(
        "hello from the paired browser",
      );
      await expect(page.locator("#codex-history-content")).toContainText(
        "Hello from fake Codex app-server.",
        { timeout: 10_000 },
      );
      expect(harness.server.streamDeltas).toEqual(
        expect.arrayContaining(["Hello from fake ", "Codex app-server."]),
      );

      await expect
        .poll(async () => {
          const devices = await menu.evaluate(() => window.peskApi.getPairingDevices());
          return devices.some((device) => device.name === "E2E browser");
        })
        .toBe(true);
    } finally {
      await page.close();
      await app.close();
    }
  });

  test("rejects an unpaired browser and an expired pairing code", async ({ browser }) => {
    const app = await harness.launch();
    const unpaired = await browser.newPage();
    const expired = await browser.newPage();
    try {
      await unpaired.goto(`http://127.0.0.1:${webPort}/web-chat.html`);
      await expect(unpaired.locator("#web-connection-status")).toHaveText("Authentication failed", {
        timeout: 10_000,
      });
      await expect(unpaired.locator("#codex-error")).toHaveText(
        "Web access authentication failed.",
      );

      await expired.goto(`http://127.0.0.1:${webPort}/pair?code=EXPIRED`);
      await expect(expired.locator("#web-connection-status")).toHaveText("Authentication failed", {
        timeout: 10_000,
      });
      await expect(expired.locator("#codex-error")).toHaveText("Pairing code expired or invalid");
    } finally {
      await unpaired.close();
      await expired.close();
      await app.close();
    }
  });

  test("rejects a browser after its paired device is revoked", async ({ browser }) => {
    const app = await harness.launch({ ...process.env, PESK_E2E_SHOW_MENU: "1" });
    const page = await browser.newPage();
    try {
      const chat = await harness.waitForChat(app);
      await expect(chat.locator(".codex-session-trigger")).toContainText("Fixture thread", {
        timeout: 10_000,
      });
      const menu = await harness.waitForMenu(app);
      const pairing = await menu.evaluate(() => window.peskApi.createPairing("Revoked browser"));
      if (!pairing) throw new Error("Pairing was not created");
      const pairingCode = new URL(pairing.urls[0] ?? "").searchParams.get("code");
      if (!pairingCode) throw new Error("Pairing URL did not contain a code");
      await page.goto(`http://127.0.0.1:${webPort}/pair?code=${encodeURIComponent(pairingCode)}`);
      await expect(page.locator("#web-connection-status")).toHaveText("Connected", {
        timeout: 10_000,
      });

      const devices = await menu.evaluate(() => window.peskApi.getPairingDevices());
      const device = devices.find((candidate) => candidate.name === "Revoked browser");
      if (!device) throw new Error("Paired browser was not listed");
      await menu.evaluate((deviceId) => window.peskApi.revokePairingDevice(deviceId), device.id);

      await expect(page.locator("#web-connection-status")).toHaveText("Authentication failed", {
        timeout: 10_000,
      });
      await expect(page.locator("#codex-error")).toHaveText("Web access authentication failed.");
    } finally {
      await page.close();
      await app.close();
    }
  });
});
