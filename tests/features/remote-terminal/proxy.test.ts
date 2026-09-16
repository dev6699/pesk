/** @jest-environment node */
/// <reference types="jest" />
/// <reference types="node" />

import type { IncomingMessage, ServerResponse } from "node:http";
import { request as httpRequest } from "node:http";
import { RtermProxy } from "../../../src/features/remote-terminal/proxy";

jest.mock("node:http", () => ({
  ...jest.requireActual("node:http"),
  request: jest.fn(),
}));

function response(): ServerResponse & {
  writeHead: jest.Mock;
  end: jest.Mock;
} {
  return {
    writeHead: jest.fn().mockReturnThis(),
    end: jest.fn().mockReturnThis(),
  } as unknown as ServerResponse & { writeHead: jest.Mock; end: jest.Mock };
}

function request(url: string, headers: IncomingMessage["headers"] = {}): IncomingMessage {
  return { url, headers, pipe: jest.fn() } as unknown as IncomingMessage;
}

describe("RtermProxy", () => {
  afterEach(() => jest.clearAllMocks());

  test("creates a scoped proxy embed URL from the direct rterm embed URL", async () => {
    const proxy = new RtermProxy({
      url: "http://rterm.test/provider/ssh",
      getEmbedUrl: async () => "http://rterm.test/provider/ssh?embed=1",
      isDeviceAuthorized: () => true,
      secure: false,
    });

    const embedUrl = await proxy.getEmbedUrl("device-1");

    expect(embedUrl).toMatch(/^\/rterm-proxy\/provider\/ssh\?embed=1&proxyToken=/);
    proxy.close();
  });

  test("rejects requests without a proxy capability", () => {
    const proxy = new RtermProxy({
      url: "http://rterm.test/provider/ssh",
      getEmbedUrl: async () => "",
      isDeviceAuthorized: () => true,
      secure: false,
    });
    const result = response();

    proxy.handleHttp(request("/rterm-proxy/provider/ssh"), result);

    expect(result.writeHead).toHaveBeenCalledWith(401);
    expect(result.end).toHaveBeenCalledWith("Authentication required");
    proxy.close();
  });

  test("returns a configuration error when the fixed upstream URL is invalid", async () => {
    const proxy = new RtermProxy({
      url: "not a URL",
      getEmbedUrl: async () => "http://rterm.test/provider/ssh?embed=1",
      isDeviceAuthorized: () => true,
      secure: false,
    });
    const embedUrl = await proxy.getEmbedUrl("device-1");
    const result = response();

    proxy.handleHttp(request(embedUrl), result);

    expect(result.writeHead).toHaveBeenCalledWith(502);
    expect(result.end).toHaveBeenCalledWith("rterm is not configured");
    proxy.close();
  });

  test("invalidates capabilities when their device is no longer authorized", async () => {
    let authorized = true;
    const proxy = new RtermProxy({
      url: "http://rterm.test/provider/ssh",
      getEmbedUrl: async () => "http://rterm.test/provider/ssh?embed=1",
      isDeviceAuthorized: () => authorized,
      secure: false,
    });
    const embedUrl = await proxy.getEmbedUrl("device-1");
    const result = response();

    authorized = false;
    proxy.handleHttp(request(embedUrl), result);

    expect(result.writeHead).toHaveBeenCalledWith(401);
    expect(result.end).toHaveBeenCalledWith("Authentication required");
    proxy.close();
  });

  test("does not forward the proxy capability cookie upstream", async () => {
    const upstreamRequest = { once: jest.fn() };
    jest.mocked(httpRequest).mockReturnValue(upstreamRequest as never);
    const proxy = new RtermProxy({
      url: "http://rterm.test/provider/ssh",
      getEmbedUrl: async () => "http://rterm.test/provider/ssh?embed=1",
      isDeviceAuthorized: () => true,
      secure: false,
    });
    const embedUrl = await proxy.getEmbedUrl("device-1");
    const token = new URL(`http://localhost${embedUrl}`).searchParams.get("proxyToken");
    const result = response();

    proxy.handleHttp(
      request("/rterm-proxy/provider/ssh", {
        cookie: `session=keep; pesk-rterm-proxy=${encodeURIComponent(token ?? "")}`,
      }),
      result,
    );

    expect(jest.mocked(httpRequest)).toHaveBeenCalledWith(
      expect.objectContaining({
        headers: expect.objectContaining({ cookie: "session=keep" }),
      }),
      expect.any(Function),
    );
    expect(jest.mocked(httpRequest).mock.calls[0][0]).not.toEqual(
      expect.objectContaining({
        headers: expect.objectContaining({ cookie: expect.stringContaining("pesk-rterm-proxy") }),
      }),
    );
    proxy.close();
  });
});
