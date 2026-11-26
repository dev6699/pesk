import { test, expect } from "playwright/test";
import { WebChatFixture } from "../../fixtures";

test.describe("browser connection recovery", () => {
  let fixture: WebChatFixture;
  let url: string;

  test.beforeEach(async () => {
    fixture = new WebChatFixture();
    url = await fixture.start();
  });

  test.afterEach(async () => fixture.stop());

  test("shows a reconnecting state when the web socket closes", async ({ page }) => {
    await page.goto(url);
    await expect(page.locator("#web-connection-status")).toHaveText("Connected");
    await page.evaluate(() => window.dispatchEvent(new Event("offline")));
    for (const socket of fixture.sockets) socket.close();
    await expect(page.locator("#web-connection-status")).toHaveText(/Reconnecting|Connecting/);
  });

  test("reconnects and returns to connected after a transient close", async ({ page }) => {
    await page.goto(url);
    await expect(page.locator("#web-connection-status")).toHaveText("Connected");
    for (const socket of fixture.sockets) socket.close();
    await expect(page.locator("#web-connection-status")).toHaveText(/Reconnecting|Connecting/);
    await expect(page.locator("#web-connection-status")).toHaveText("Connected");
  });

  test("retries from the connection-status control", async ({ page }) => {
    await page.goto(url);
    await expect(page.locator("#web-connection-status")).toHaveText("Connected");
    for (const socket of fixture.sockets) socket.close();
    await expect(page.locator("#web-connection-status")).toHaveText(/Reconnecting|Connecting/);

    await page.getByRole("button", { name: /Reconnecting|Connecting/ }).click();
    await expect(page.locator("#web-connection-status")).toHaveText("Connected");
  });

  test("reconnects when the browser comes back online", async ({ page }) => {
    await page.goto(url);
    await expect(page.locator("#web-connection-status")).toHaveText("Connected");
    await page.evaluate(() => window.dispatchEvent(new Event("offline")));
    for (const socket of fixture.sockets) socket.close();
    await expect(page.locator("#web-connection-status")).toHaveText(/Reconnecting|Connecting/);

    await page.evaluate(() => window.dispatchEvent(new Event("online")));
    await expect(page.locator("#web-connection-status")).toHaveText("Connected");
  });

  for (const lifecycle of ["visibility", "focus"] as const) {
    test(`immediately replaces an open socket on ${lifecycle} resume`, async ({ page }) => {
      const urlPaths: string[] = [];
      page.on("websocket", (socket) => urlPaths.push(new URL(socket.url()).pathname));
      await page.goto(url);
      const status = page.locator("#web-connection-status");
      await expect(status).toHaveText("Connected");
      const [oldSocket] = fixture.sockets;
      const resumeStatus = await page.evaluate((lifecycle) => {
        if (lifecycle === "visibility") {
          Object.defineProperty(document, "visibilityState", {
            configurable: true,
            value: "hidden",
          });
          document.dispatchEvent(new Event("visibilitychange"));
          Object.defineProperty(document, "visibilityState", { value: "visible" });
          document.dispatchEvent(new Event("visibilitychange"));
        } else {
          window.dispatchEvent(new Event("blur"));
        }
        window.dispatchEvent(new Event("focus"));
        window.dispatchEvent(new Event("pageshow"));
        return document.getElementById("web-connection-status")?.textContent;
      }, lifecycle);

      expect(resumeStatus).toBe("Connecting…");
      await expect(status).toHaveText("Connected");
      await expect.poll(() => fixture.sockets.has(oldSocket)).toBe(false);
      expect(urlPaths).toEqual(["/web-socket", "/web-socket"]);
    });
  }

  test("shows an authentication failure and clears stale credentials", async ({ page }) => {
    await fixture.stop();
    fixture = new WebChatFixture(undefined, { rejectAuthentication: true });
    url = await fixture.start();
    await page.addInitScript(() => localStorage.setItem("pesk-device-credential", "stale"));
    await page.goto(url);
    await expect(page.locator("#web-connection-status")).toHaveText("Authentication failed");
    await expect(page.locator("#codex-error")).toHaveText("Web access authentication failed.");
    expect(await page.evaluate(() => localStorage.getItem("pesk-device-credential"))).toBeNull();
    expect(
      await page.evaluate(() => {
        window.dispatchEvent(new Event("focus"));
        window.dispatchEvent(new Event("online"));
        return document.getElementById("web-connection-status")?.textContent;
      }),
    ).toBe("Authentication failed");
  });

  test("shows a pairing error when the code exchange is rejected", async ({ page }) => {
    await fixture.stop();
    fixture = new WebChatFixture(undefined, { rejectPairing: true });
    url = await fixture.start();
    await page.goto(`${url}?code=EXPIRED`);
    await expect(page.locator("#web-connection-status")).toHaveText("Authentication failed");
    await expect(page.locator("#codex-error")).toHaveText("Pairing code expired or invalid");
  });
});
