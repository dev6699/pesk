/** @jest-environment node */
/// <reference types="jest" />
/// <reference path="../src/renderer/types.d.ts" />

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { request } from "node:http";
import * as path from "node:path";
import webpush from "web-push";
import { WebSocket as ClientWebSocket } from "ws";
import { ChatWebServer, type ChatWebServerOptions } from "../src/chat-web-server";

jest.mock("web-push", () => ({
  __esModule: true,
  default: {
    generateVAPIDKeys: jest.fn(() => ({ publicKey: "public-key", privateKey: "private-key" })),
    setVapidDetails: jest.fn(),
    sendNotification: jest.fn(() => Promise.resolve()),
  },
}));

const mockedWebpush = webpush as jest.Mocked<typeof webpush>;

interface Response {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

function httpRequest(port: number, method: string, url: string, body?: unknown, credential?: string): Promise<Response> {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const client = request({
      host: "127.0.0.1",
      port,
      path: url,
      method,
      headers: {
        ...(payload ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) } : {}),
        ...(credential ? { Authorization: `Bearer ${credential}` } : {}),
      },
    }, (response) => {
      let result = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => { result += chunk; });
      response.on("end", () => resolve({ status: response.statusCode ?? 0, headers: response.headers, body: result }));
    });
    client.on("error", reject);
    if (payload) client.write(payload);
    client.end();
  });
}

function json(response: Response): any {
  return JSON.parse(response.body);
}

function subscription(endpoint: string): Record<string, unknown> {
  return { endpoint, keys: { p256dh: "p256dh", auth: "auth" } };
}

describe("ChatWebServer", () => {
  let directory: string;
  let server: ChatWebServer;
  let port: number;
  let state: Record<string, unknown>;

  beforeEach(async () => {
    directory = mkdtempSync(path.join("/dev/shm", "pesk-web-test-"));
    state = { codexStatus: "idle", codexPendingApproval: false, codexPendingUserInput: false };
    const options: ChatWebServerOptions = {
      enabled: true,
      port: 4611,
      listenHost: "127.0.0.1",
      rendererDirectory: path.join(process.cwd(), "src", "renderer"),
      webPushVapidPath: path.join(directory, "vapid.json"),
      webPushSubscriptionsPath: path.join(directory, "subscriptions.json"),
      deviceCredentialsPath: path.join(directory, "devices.json"),
      getState: () => state,
      handleCommand: jest.fn(),
      debug: jest.fn(),
    };
    server = new ChatWebServer(options);
    await server.start();
    port = 4611;
  });

  afterEach(() => {
    server.stop();
    rmSync(directory, { recursive: true, force: true });
    jest.clearAllMocks();
  });

  async function pair(name = "Phone"): Promise<{ credential: string; deviceId: string }> {
    const pairing = await server.createPairing(name);
    expect(pairing?.qrDataUrl).toMatch(/^data:image\/png;base64,/);
    const exchange = await httpRequest(port, "POST", "/pair/exchange", { code: pairing?.code });
    expect(exchange.status).toBe(200);
    return json(exchange);
  }

  test("creates a pairing code and exchanges it only once", async () => {
    const pairing = await server.createPairing("Phone");
    expect(pairing?.urls[0]).toContain("pair?code=");
    expect(server.getPairingStatus().active).toBe(true);

    const first = await httpRequest(port, "POST", "/pair/exchange", { code: pairing?.code?.toLowerCase() });
    expect(first.status).toBe(200);
    expect(json(first).credential).toEqual(expect.any(String));
    expect(server.getPairingStatus()).toEqual({ active: false, pairedDeviceName: "Phone" });

    const second = await httpRequest(port, "POST", "/pair/exchange", { code: pairing?.code });
    expect(second.status).toBe(400);
    await expect(server.createPairing("phone")).rejects.toThrow("already in use");
  });

  test("protects push configuration and subscription endpoints with the paired credential", async () => {
    const paired = await pair();
    expect((await httpRequest(port, "GET", "/web-push/config")).status).toBe(401);
    expect((await httpRequest(port, "GET", "/web-push/config", undefined, "wrong")).status).toBe(401);
    expect((await httpRequest(port, "GET", "/web-push/config", undefined, paired.credential)).status).toBe(200);
    expect((await httpRequest(port, "GET", "/web-push/subscribe", undefined, paired.credential)).status).toBe(405);
    expect((await httpRequest(port, "POST", "/web-push/subscribe", { bad: true }, paired.credential)).status).toBe(400);
  });

  test("registers one subscription per device and computes pushRegistered", async () => {
    const paired = await pair();
    const first = await httpRequest(port, "POST", "/web-push/subscribe", subscription("https://push.test/one"), paired.credential);
    expect(first.status).toBe(200);
    expect(server.listDevices()[0]).toMatchObject({ id: paired.deviceId, pushRegistered: true });

    await httpRequest(port, "POST", "/web-push/subscribe", subscription("https://push.test/two"), paired.credential);
    const stored = JSON.parse(readFileSync(path.join(directory, "subscriptions.json"), "utf8"));
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({ endpoint: "https://push.test/two", deviceId: paired.deviceId });

    const deleted = await httpRequest(port, "DELETE", "/web-push/subscribe?endpoint=https%3A%2F%2Fpush.test%2Ftwo", undefined, paired.credential);
    expect(deleted.status).toBe(200);
    expect(server.listDevices()[0].pushRegistered).toBe(false);
  });

  test("toggles delivery policy without changing registration", async () => {
    const paired = await pair();
    await httpRequest(port, "POST", "/web-push/subscribe", subscription("https://push.test/toggle"), paired.credential);
    server.setDevicePushEnabled(paired.deviceId, false);
    expect(server.listDevices()[0]).toMatchObject({ pushEnabled: false, pushRegistered: true });
    server.setDevicePushEnabled(paired.deviceId, true);
    expect(server.listDevices()[0].pushEnabled).toBe(true);
  });

  test("revokes device access, sockets, and subscriptions", async () => {
    const paired = await pair();
    await httpRequest(port, "POST", "/web-push/subscribe", subscription("https://push.test/revoke"), paired.credential);
    server.revokeDevice(paired.deviceId);
    expect(server.listDevices()).toHaveLength(0);
    expect(JSON.parse(readFileSync(path.join(directory, "subscriptions.json"), "utf8"))).toHaveLength(0);
    expect((await httpRequest(port, "GET", "/web-push/config", undefined, paired.credential)).status).toBe(401);
  });

  test("sends state notifications only for transitions and enabled devices", async () => {
    const paired = await pair();
    await httpRequest(port, "POST", "/web-push/subscribe", subscription("https://push.test/send"), paired.credential);
    server.broadcast({ codexStatus: "idle" });
    server.broadcast({ codexStatus: "working" });
    server.broadcast({ codexStatus: "idle" });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(mockedWebpush.sendNotification).toHaveBeenCalledTimes(1);

    server.setDevicePushEnabled(paired.deviceId, false);
    server.broadcast({ codexStatus: "working" });
    server.broadcast({ codexStatus: "idle" });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(mockedWebpush.sendNotification).toHaveBeenCalledTimes(1);
  });

  test("sends approval and user-input notifications", async () => {
    const paired = await pair();
    await httpRequest(port, "POST", "/web-push/subscribe", subscription("https://push.test/events"), paired.credential);
    server.broadcast({ codexPendingApproval: false, codexPendingUserInput: false });
    server.broadcast({ codexPendingApproval: true, codexPendingUserInput: false });
    server.broadcast({ codexPendingApproval: true, codexPendingUserInput: true });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(mockedWebpush.sendNotification).toHaveBeenCalledTimes(2);
    expect(mockedWebpush.sendNotification.mock.calls[0][1]).toContain('"kind":"approval"');
    expect(mockedWebpush.sendNotification.mock.calls[1][1]).toContain('"kind":"input"');
  });

  test("removes subscriptions that are permanently rejected", async () => {
    const paired = await pair();
    await httpRequest(port, "POST", "/web-push/subscribe", subscription("https://push.test/expired"), paired.credential);
    mockedWebpush.sendNotification.mockRejectedValueOnce({ statusCode: 410 });
    server.broadcast({ codexStatus: "idle" });
    server.broadcast({ codexStatus: "working" });
    server.broadcast({ codexStatus: "idle" });
    await new Promise<void>((resolve) => setImmediate(resolve));
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(server.listDevices()[0].pushRegistered).toBe(false);
  });

  test("ignores invalid state and unknown device operations", () => {
    server.broadcast(null as unknown as Record<string, unknown>);
    server.setDevicePushEnabled("missing", false);
    server.revokeDevice("missing");
    expect(server.listDevices()).toHaveLength(0);
  });

  test("authenticates WebSocket clients and replies to commands", async () => {
    const paired = await pair();
    const handleCommand = (server as unknown as { options: ChatWebServerOptions }).options.handleCommand as jest.Mock;
    const client = new ClientWebSocket(`ws://127.0.0.1:${port}/web-socket`);
    const messages: string[] = [];
    client.on("message", (data) => messages.push(data.toString()));
    await new Promise<void>((resolve) => client.once("open", resolve));
    client.send(JSON.stringify({ type: "authenticate", credential: paired.credential }));
    await new Promise<void>((resolve) => setTimeout(resolve, 30));
    expect(JSON.parse(messages[0])).toEqual({ type: "state", state });
    client.send(JSON.stringify({ type: "command", value: 1 }));
    await new Promise<void>((resolve) => setTimeout(resolve, 30));
    expect(handleCommand).toHaveBeenCalled();
    const reply = handleCommand.mock.calls[0][1] as (value: unknown) => void;
    reply({ type: "reply", ok: true });
    await new Promise<void>((resolve) => setTimeout(resolve, 30));
    expect(messages.some((message) => message.includes('"ok":true'))).toBe(true);
    client.close();
  });

  test("closes malformed and unauthorized WebSocket clients", async () => {
    const invalid = new ClientWebSocket(`ws://127.0.0.1:${port}/web-socket`);
    await new Promise<void>((resolve) => invalid.once("open", resolve));
    const invalidClose = new Promise<number>((resolve) => invalid.once("close", (code) => resolve(code)));
    invalid.send("not-json");
    expect(await invalidClose).toBe(1007);

    const unauthorized = new ClientWebSocket(`ws://127.0.0.1:${port}/web-socket`);
    await new Promise<void>((resolve) => unauthorized.once("open", resolve));
    const unauthorizedClose = new Promise<number>((resolve) => unauthorized.once("close", (code) => resolve(code)));
    unauthorized.send(JSON.stringify({ type: "authenticate", credential: "wrong" }));
    expect(await unauthorizedClose).toBe(1008);
  });

  test("immediately closes a revoked WebSocket client", async () => {
    const paired = await pair("Revoked live");
    const client = new ClientWebSocket(`ws://127.0.0.1:${port}/web-socket`);
    await new Promise<void>((resolve) => client.once("open", resolve));
    const closed = new Promise<number>((resolve) => client.once("close", (code) => resolve(code)));
    client.send(JSON.stringify({ type: "authenticate", credential: paired.credential }));
    await new Promise<void>((resolve) => setTimeout(resolve, 30));
    server.revokeDevice(paired.deviceId);
    expect(await closed).toBe(1008);
  });

});
