import { test, expect } from "../../helpers/electron-test";
import { createServer } from "node:net";
import { ElectronCodexHarness } from "../../helpers/electron-codex";
import { FakeRtermServer } from "../../servers/rterm/server";

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

test.describe("remote terminal proxy", () => {
  let harness: ElectronCodexHarness;
  let rterm: FakeRtermServer;
  let webPort: number;

  test.beforeEach(async ({ electronProfile }) => {
    rterm = new FakeRtermServer();
    await rterm.ready();
    harness = new ElectronCodexHarness(electronProfile);
    await harness.start();
    webPort = await freePort();
    harness.writeConfig({
      webAccessEnabled: true,
      webPort,
      features: { remoteTerminal: { enabled: true, url: rterm.url } },
    });
  });

  test.afterEach(async () => {
    await harness.dispose();
    await rterm.close();
  });

  test("pairs a browser and proxies authenticated rterm HTTP and WebSocket traffic", async ({
    browser,
  }) => {
    const app = await harness.launch({ ...process.env, PESK_E2E_SHOW_MENU: "1" });
    const page = await browser.newPage();
    const webBase = "http://127.0.0.1:" + webPort;
    const menu = await harness.waitForMenu(app);
    await menu.waitForLoadState("domcontentloaded");
    const pairing = await menu.evaluate(() => window.peskApi.createPairing("E2E terminal"));
    if (!pairing) throw new Error("Pairing was not created");

    await expect.poll(async () => (await fetch(webBase + "/pair")).status).toBe(200);
    const pairingCode = new URL(pairing.urls[0] ?? "").searchParams.get("code");
    if (!pairingCode) throw new Error("Pairing URL did not contain a code");
    await page.goto(webBase + "/pair?code=" + encodeURIComponent(pairingCode));
    await expect(page.locator("#web-connection-status")).toHaveText("Connected");
    await menu.evaluate(() => window.peskApi.closeMenuWindow());

    const chatInput = page.getByRole("textbox", { name: "Message Codex" });
    await chatInput.fill("hello from the paired browser");
    await page.getByRole("button", { name: "Send" }).click();
    await expect(page.locator("#codex-history-content")).toContainText(
      "Hello from fake Codex app-server.",
    );

    const input = page.getByRole("textbox", { name: "Message Codex" });
    await input.fill("/rterm");
    await page.getByRole("button", { name: "Send" }).click();
    await expect(page.locator("#rterm-frame")).toHaveAttribute("src", /rterm-proxy\/provider\/ssh/);
    await expect(page.frameLocator("#rterm-frame").locator("#fake-rterm")).toHaveText("Fake rterm");
    await expect.poll(() => rterm.webSockets.size).toBeGreaterThan(0);
    expect(rterm.httpRequests.some((request) => request.startsWith("/provider/ssh?embed=1"))).toBe(
      true,
    );
    expect(rterm.httpRequests).toContain("/provider/ssh/client.js");

    const rtermFrame = page.frames().find((frame) => frame.url().includes("rterm-proxy"));
    if (!rtermFrame) throw new Error("Rterm frame did not attach to the paired browser");
    await rtermFrame.evaluate(() =>
      (window as Window & { fakeRtermSend?: (value: string) => void }).fakeRtermSend?.("input"),
    );
    await expect.poll(() => rterm.socketMessages).toContain("input");
    await expect(rtermFrame.locator("#fake-rterm-output")).toContainText("input");
    await expect(rtermFrame.locator("body")).toHaveAttribute("data-websocket", "connected");
    for (const socket of rterm.webSockets) socket.terminate();
    await expect.poll(() => rterm.webSockets.size).toBeGreaterThan(0);
    await expect(rtermFrame.locator("body")).toHaveAttribute("data-websocket", "connected");

    const unauthorized = await fetch(webBase + "/rterm-proxy/provider/ssh");
    expect(unauthorized.status).toBe(401);

    const devices = await menu.evaluate(() => window.peskApi.getPairingDevices());
    const device = devices.find((entry) => entry.name === "E2E terminal");
    if (!device) throw new Error("Paired device was not listed");
    await menu.evaluate((deviceId) => window.peskApi.revokePairingDevice(deviceId), device.id);
    await expect(page.locator("#web-connection-status")).toHaveText("Authentication failed");
    await page.close();
  });

  test("executes a Codex remote-terminal command through the native rterm bridge", async () => {
    harness.server.enableRemoteTerminal();
    const app = await harness.launch();
    const chat = await harness.waitForChat(app);
    await expect(chat.locator(".codex-session-trigger")).toBeVisible();
    await expect(chat.locator(".codex-session-trigger")).toContainText("Fixture thread");
    const input = chat.getByRole("textbox", { name: "Message Codex" });
    await input.fill("/rterm");
    await chat.getByRole("button", { name: "Send" }).click();
    await expect(chat.locator("#rterm-panel")).toBeVisible();
    await expect(chat.frameLocator("#rterm-frame").locator("#fake-rterm")).toHaveText("Fake rterm");

    await input.fill("run a remote command");
    await chat.getByRole("button", { name: "Send" }).click();
    await expect.poll(() => harness.server.prompts).toEqual(["run a remote command"]);
    await expect.poll(() => harness.server.serverMethods).toContain("item/tool/call");
    const approval = chat.locator("#codex-user-input");
    await expect(approval).toContainText("echo from codex");
    await approval.getByRole("radio", { name: /Allow remote operation/ }).check();
    await approval.getByRole("button", { name: "Submit" }).click();

    await expect(
      chat.frameLocator("#rterm-frame").locator("body[data-sessions-requested='true']"),
    ).toBeVisible();
    await expect.poll(() => rterm.httpRequests).toContain("/api/sessions/session-1/execute");
    await expect.poll(() => rterm.commands).toEqual(["echo from codex"]);
    await expect(chat.locator("#codex-history-content")).toContainText(
      "Hello from fake Codex app-server.",
    );
    expect(harness.server.dynamicToolResponses).toEqual([
      {
        contentItems: [
          {
            type: "inputText",
            text: '[{"sessionId":"session-1","provider":"fake","target":"e2e-host","user":"e2e"}]',
          },
        ],
        success: true,
      },
      {
        contentItems: [{ type: "inputText", text: "completed; exitCode=0\nfake command output\n" }],
        success: true,
      },
    ]);
  });

  test("rejects invalid and expired rterm capabilities", async ({ browser }) => {
    const app = await harness.launch({
      ...process.env,
      PESK_E2E_SHOW_MENU: "1",
      PESK_E2E_RTERM_CAPABILITY_TTL_MS: "50",
    });
    const page = await browser.newPage();
    const webBase = `http://127.0.0.1:${webPort}`;
    const menu = await harness.waitForMenu(app);
    const pairing = await menu.evaluate(() => window.peskApi.createPairing("E2E capability"));
    if (!pairing) throw new Error("Pairing was not created");
    const pairingCode = new URL(pairing.urls[0] ?? "").searchParams.get("code");
    if (!pairingCode) throw new Error("Pairing URL did not contain a code");
    await page.goto(`${webBase}/pair?code=${encodeURIComponent(pairingCode)}`);
    await expect(page.locator("#web-connection-status")).toHaveText("Connected");

    const input = page.getByRole("textbox", { name: "Message Codex" });
    await input.fill("/rterm");
    await page.getByRole("button", { name: "Send" }).click();
    const frame = page.locator("#rterm-frame");
    await expect(frame).toHaveAttribute("src", /rterm-proxy\/provider\/ssh/);
    const embedUrl = await frame.getAttribute("src");
    if (!embedUrl) throw new Error("Rterm embed URL was not created");

    const invalid = new URL(embedUrl, webBase);
    invalid.searchParams.set("proxyToken", "wrong-device-capability");
    expect(await page.evaluate(async (url) => (await fetch(url)).status, invalid.toString())).toBe(
      401,
    );

    await expect
      .poll(() =>
        page.evaluate(
          async (url) => (await fetch(url)).status,
          new URL(embedUrl, webBase).toString(),
        ),
      )
      .toBe(401);
    await page.close();
  });
});
