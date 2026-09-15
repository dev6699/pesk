/** @jest-environment jsdom */
/// <reference types="jest" />

import { setupRtermRenderer } from "../../../../src/renderer/features/chat/rterm-renderer";
import { RtermSnapshot } from "../../../../src/features/remote-terminal/rterm-client";

describe("rterm renderer", () => {
  test("keeps session lifecycle in rterm", async () => {
    document.body.innerHTML = `
      <section id="rterm-panel"><div id="rterm-resize-handle"></div>
        <div id="rterm-toolbar"><button id="rterm-refresh"></button><button id="rterm-close"></button></div>
        <iframe id="rterm-frame"></iframe></section>`;
    const api = {
      getRterm: jest.fn().mockResolvedValue(snapshot("disconnected")),
      getRtermEmbedUrl: jest.fn().mockResolvedValue("http://remote.example/provider/ssh?embed=1"),
    };
    (window as unknown as { peskApi: typeof api }).peskApi = api;
    setupRtermRenderer();
    await Promise.resolve();
    const panel = document.getElementById("rterm-panel") as HTMLElement;
    document.getElementById("rterm-refresh")?.dispatchEvent(new Event("click"));
    document.getElementById("rterm-close")?.dispatchEvent(new Event("click"));
    expect(panel.hidden).toBe(true);
  });

  test("does not forward rterm session selection to Pesk", async () => {
    document.body.innerHTML = `
      <section id="rterm-panel"><div id="rterm-resize-handle"></div>
        <button id="rterm-close"></button><iframe id="rterm-frame"></iframe></section>`;
    const api = {
      getRterm: jest.fn().mockResolvedValue(snapshot("connected")),
      getRtermEmbedUrl: jest.fn().mockResolvedValue(""),
    };
    (window as unknown as { peskApi: typeof api }).peskApi = api;
    setupRtermRenderer();
    const frame = document.getElementById("rterm-frame") as HTMLIFrameElement;
    frame.src = "http://remote.example/provider/ssh?embed=1";
    await Promise.resolve();
    window.dispatchEvent(
      new MessageEvent("message", {
        data: { source: "rterm", type: "session-selected", sessionId: "session-2" },
        source: frame.contentWindow,
        origin: "http://remote.example",
      }),
    );
    expect(frame.contentWindow).toBeTruthy();
  });

  test("forwards session requests and selection to the active iframe", async () => {
    document.body.innerHTML = `
      <section id="rterm-panel"><div id="rterm-resize-handle"></div>
        <button id="rterm-close"></button><iframe id="rterm-frame"></iframe></section>`;
    const requestListeners: Array<(threadId: string, request: { requestId: string }) => void> = [];
    const selectionListeners: Array<(threadId: string, sessionId: string) => void> = [];
    const api = {
      onRtermSessionsRequest: jest.fn((callback) => requestListeners.push(callback)),
      onRtermSessionSelection: jest.fn((callback) => selectionListeners.push(callback)),
      sendRtermSessionsResponse: jest.fn(),
      getRterm: jest.fn().mockResolvedValue(snapshot("connected")),
      getRtermEmbedUrl: jest.fn().mockResolvedValue(""),
    };
    (window as unknown as { peskApi: typeof api }).peskApi = api;
    const frame = document.getElementById("rterm-frame") as HTMLIFrameElement;
    frame.src = "http://remote.example/provider/ssh?embed=1";
    const postMessage = jest.spyOn(frame.contentWindow!, "postMessage");
    setupRtermRenderer();

    requestListeners[0]("standalone", { requestId: "call-1" });
    selectionListeners[0]("standalone", "session-2");

    expect(postMessage).toHaveBeenNthCalledWith(
      1,
      { source: "pesk", type: "sessions-request", requestId: "call-1" },
      "http://remote.example",
    );
    expect(postMessage).toHaveBeenNthCalledWith(
      2,
      { source: "pesk", type: "select-session", sessionId: "session-2" },
      "http://remote.example",
    );
  });

  test("accepts only session responses from the exact iframe origin", () => {
    document.body.innerHTML = `
      <section id="rterm-panel"><div id="rterm-resize-handle"></div>
        <button id="rterm-close"></button><iframe id="rterm-frame"></iframe></section>`;
    const api = {
      sendRtermSessionsResponse: jest.fn(),
      getRterm: jest.fn().mockResolvedValue(snapshot("connected")),
      getRtermEmbedUrl: jest.fn().mockResolvedValue(""),
    };
    (window as unknown as { peskApi: typeof api }).peskApi = api;
    const frame = document.getElementById("rterm-frame") as HTMLIFrameElement;
    frame.src = "http://remote.example/provider/ssh?embed=1";
    setupRtermRenderer();

    const response = {
      source: "rterm",
      type: "sessions-response",
      requestId: "call-1",
      ok: true,
      connected: true,
    };
    window.dispatchEvent(
      new MessageEvent("message", {
        data: response,
        source: frame.contentWindow,
        origin: "http://attacker.example",
      }),
    );
    expect(api.sendRtermSessionsResponse).not.toHaveBeenCalled();

    window.dispatchEvent(
      new MessageEvent("message", {
        data: { ...response, result: [{ sessionId: "session-1" }] },
        source: frame.contentWindow,
        origin: "http://remote.example",
      }),
    );
    expect(api.sendRtermSessionsResponse).toHaveBeenCalledWith("standalone", {
      requestId: "call-1",
      ok: true,
      connected: true,
      result: [{ sessionId: "session-1" }],
      error: undefined,
    });
  });

  test("returns no renderer when required markup is missing", () => {
    document.body.innerHTML = "<section id='rterm-panel'></section>";
    expect(setupRtermRenderer()).toBeUndefined();
  });
  test("loads and refreshes the provider iframe", async () => {
    document.body.innerHTML = `
      <section id="rterm-panel" hidden>
        <div id="rterm-resize-handle"></div>
        <div id="rterm-toolbar"><span id="rterm-status"></span><button id="rterm-refresh"></button><button id="rterm-connection"></button><button id="rterm-close"></button></div>
        <iframe id="rterm-frame"></iframe>
      </section>`;
    const api = {
      getRterm: jest.fn().mockResolvedValue(snapshot("authenticating")),
      getRtermEmbedUrl: jest.fn().mockResolvedValue("http://remote.example/provider/ssh?embed=1"),
    };
    (window as unknown as { peskApi: typeof api }).peskApi = api;

    setupRtermRenderer();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(api.getRterm).toHaveBeenCalled();
    expect(api.getRtermEmbedUrl).not.toHaveBeenCalled();
    document.dispatchEvent(new Event("toggle-rterm"));
    expect(api.getRtermEmbedUrl).toHaveBeenCalled();
    await Promise.resolve();
    const frame = document.getElementById("rterm-frame") as HTMLIFrameElement;
    const source = "http://remote.example/provider/ssh?embed=1";
    const embeddedUrl = new URL(frame.src);
    expect(embeddedUrl.origin + embeddedUrl.pathname + "?embed=1").toBe(source);
    expect(embeddedUrl.searchParams.has("parentOrigin")).toBe(false);
    expect(embeddedUrl.searchParams.get("bridgeToken")).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
    const embedCallsBeforeRefresh = api.getRtermEmbedUrl.mock.calls.length;
    document.getElementById("rterm-refresh")?.dispatchEvent(new Event("click"));
    expect(api.getRtermEmbedUrl).toHaveBeenCalledTimes(embedCallsBeforeRefresh);
    expect(frame.src).toContain("/provider/ssh");
  });

  test("resizes the panel through the drag handle", () => {
    document.body.innerHTML = `
      <section id="rterm-panel"><div id="rterm-resize-handle"></div>
        <div id="rterm-toolbar"><span id="rterm-status"></span><button id="rterm-connection"></button><button id="rterm-close"></button></div>
        <iframe id="rterm-frame"></iframe></section>`;
    const api = {
      getRterm: jest.fn().mockResolvedValue(snapshot("disconnected")),
      getRtermEmbedUrl: jest.fn().mockResolvedValue(""),
    };
    (window as unknown as { peskApi: typeof api }).peskApi = api;
    const handle = document.getElementById("rterm-resize-handle") as HTMLElement & {
      setPointerCapture: () => void;
      releasePointerCapture: () => void;
      hasPointerCapture: () => boolean;
    };
    handle.setPointerCapture = jest.fn();
    handle.releasePointerCapture = jest.fn();
    handle.hasPointerCapture = jest.fn().mockReturnValue(true);
    (document.getElementById("rterm-panel") as HTMLElement).getBoundingClientRect = () =>
      ({ height: 140 }) as DOMRect;
    setupRtermRenderer();
    const down = new Event("pointerdown", { bubbles: true }) as Event & {
      clientY: number;
      pointerId: number;
    };
    down.clientY = 100;
    down.pointerId = 1;
    handle.dispatchEvent(down);
    const move = new Event("pointermove") as Event & { clientY: number };
    move.clientY = 50;
    handle.dispatchEvent(move);
    handle.dispatchEvent(new Event("pointerup"));
    expect((document.getElementById("rterm-panel") as HTMLElement).style.height).toBe("190px");
  });

  test("docks the terminal to the right and resizes its width", () => {
    document.body.innerHTML = `
      <section id="codex-chat">
        <section id="rterm-panel"><div id="rterm-resize-handle"></div>
          <div id="rterm-toolbar"><button id="rterm-layout"></button><button id="rterm-close"></button></div>
          <iframe id="rterm-frame"></iframe></section>
      </section>`;
    const api = {
      getRterm: jest.fn().mockResolvedValue(snapshot("disconnected")),
      getRtermEmbedUrl: jest.fn().mockResolvedValue(""),
    };
    (window as unknown as { peskApi: typeof api }).peskApi = api;
    const handle = document.getElementById("rterm-resize-handle") as HTMLElement & {
      setPointerCapture: () => void;
      releasePointerCapture: () => void;
      hasPointerCapture: () => boolean;
    };
    handle.setPointerCapture = jest.fn();
    handle.releasePointerCapture = jest.fn();
    handle.hasPointerCapture = jest.fn().mockReturnValue(true);
    (document.getElementById("rterm-panel") as HTMLElement).getBoundingClientRect = () =>
      ({ width: 360, height: 220 }) as DOMRect;
    (document.getElementById("codex-chat") as HTMLElement).getBoundingClientRect = () =>
      ({ width: 1000, height: 600 }) as DOMRect;
    const panel = document.getElementById("rterm-panel") as HTMLElement;
    panel.style.height = "190px";
    panel.style.flexBasis = "190px";
    setupRtermRenderer();

    const layoutButton = document.getElementById("rterm-layout") as HTMLButtonElement;
    layoutButton.click();
    expect(document.getElementById("codex-chat")?.classList.contains("rterm-side-layout")).toBe(
      true,
    );
    expect(panel.style.height).toBe("");
    expect(panel.style.flexBasis).toBe("");
    expect(layoutButton.querySelector("path")?.getAttribute("d")).toBe("M3 15h18");
    expect(handle.getAttribute("aria-orientation")).toBe("vertical");

    const down = new Event("pointerdown", { bubbles: true }) as Event & {
      clientX: number;
      pointerId: number;
    };
    down.clientX = 200;
    down.pointerId = 1;
    handle.dispatchEvent(down);
    const move = new Event("pointermove") as Event & { clientX: number };
    move.clientX = 150;
    handle.dispatchEvent(move);

    expect(
      document.getElementById("codex-chat")?.style.getPropertyValue("--rterm-side-width"),
    ).toBe("41%");

    (document.getElementById("rterm-close") as HTMLButtonElement).click();
    expect(document.getElementById("codex-chat")?.classList.contains("rterm-side-layout")).toBe(
      false,
    );
  });

  test("does not post legacy terminal reset messages", () => {
    document.body.innerHTML = `
      <section id="rterm-panel">
        <div id="rterm-resize-handle"></div>
        <div id="rterm-toolbar"><span id="rterm-status"></span><button id="rterm-connection"></button><button id="rterm-close"></button></div>
        <iframe id="rterm-frame"></iframe>
      </section>`;
    const api = {
      getRterm: jest.fn().mockResolvedValue(snapshot("disconnected")),
      getRtermEmbedUrl: jest.fn().mockResolvedValue(""),
    };
    (window as unknown as { peskApi: typeof api }).peskApi = api;
    const frame = document.getElementById("rterm-frame") as HTMLIFrameElement;
    const postMessage = jest.spyOn(frame.contentWindow!, "postMessage");
    setupRtermRenderer();

    expect(postMessage.mock.calls.filter(([message]) => message.type === "reset")).toHaveLength(0);
  });

  test("does not replay the snapshot when the selected thread is unchanged", () => {
    document.body.innerHTML = `
      <section id="rterm-panel">
        <div id="rterm-resize-handle"></div>
        <div id="rterm-toolbar"><span id="rterm-status"></span><button id="rterm-connection"></button><button id="rterm-close"></button></div>
        <iframe id="rterm-frame"></iframe>
      </section>`;
    const api = {
      getRterm: jest.fn().mockResolvedValue(snapshot("connected")),
      getRtermEmbedUrl: jest.fn().mockResolvedValue(""),
    };
    (window as unknown as { peskApi: typeof api }).peskApi = api;
    const frame = document.getElementById("rterm-frame") as HTMLIFrameElement;
    const postMessage = jest.spyOn(frame.contentWindow!, "postMessage");
    const renderer = setupRtermRenderer();

    renderer?.setThread("thread-1");
    const callsAfterThreadChange = postMessage.mock.calls.length;
    renderer?.setThread("thread-1");

    expect(postMessage.mock.calls).toHaveLength(callsAfterThreadChange);
  });

  test("reloads the embed URL when reconnecting after a failed load", async () => {
    document.body.innerHTML = `
      <section id="rterm-panel" hidden>
        <div id="rterm-resize-handle"></div>
        <div id="rterm-toolbar"><span id="rterm-status"></span><button id="rterm-connection"></button><button id="rterm-close"></button></div>
        <iframe id="rterm-frame"></iframe>
      </section>`;
    const api = {
      getRterm: jest.fn().mockResolvedValue(snapshot("disconnected")),
      getRtermEmbedUrl: jest.fn().mockResolvedValue("http://remote.example/bash?embed=1"),
    };
    (window as unknown as { peskApi: typeof api }).peskApi = api;
    setupRtermRenderer();
    const initialCalls = api.getRtermEmbedUrl.mock.calls.length;
    document.dispatchEvent(new Event("toggle-rterm"));
    await Promise.resolve();
    const callsAfterShow = api.getRtermEmbedUrl.mock.calls.length;
    expect(callsAfterShow).toBeGreaterThan(initialCalls);
  });

  test("preserves the initial provider iframe when returning to the first thread", async () => {
    document.body.innerHTML = `
      <section id="rterm-panel" hidden>
        <div id="rterm-resize-handle"></div>
        <div id="rterm-toolbar"><span id="rterm-status"></span><button id="rterm-connection"></button><button id="rterm-close"></button></div>
        <iframe id="rterm-frame"></iframe>
      </section>`;
    const api = {
      getRterm: jest.fn().mockResolvedValue(snapshot("disconnected")),
      getRtermEmbedUrl: jest.fn().mockResolvedValue("http://remote.example/provider/ssh?embed=1"),
    };
    (window as unknown as { peskApi: typeof api }).peskApi = api;
    const renderer = setupRtermRenderer();
    renderer?.setThread("thread-1");
    document.dispatchEvent(new Event("toggle-rterm"));
    await Promise.resolve();
    await Promise.resolve();

    const firstFrame = document.getElementById("rterm-frame") as HTMLIFrameElement;
    renderer?.setThread("thread-2");
    const secondFrame = document.querySelectorAll("#rterm-panel iframe")[1] as HTMLIFrameElement;
    renderer?.setThread("thread-1");

    expect(document.querySelectorAll("#rterm-panel iframe")).toHaveLength(2);
    expect(firstFrame.hidden).toBe(false);
    expect(secondFrame.hidden).toBe(true);
    expect(firstFrame.src).toContain("/provider/ssh");
  });

  test("loads the selected thread snapshot before loading its provider page", async () => {
    document.body.innerHTML = `
      <section id="rterm-panel">
        <div id="rterm-resize-handle"></div>
        <div id="rterm-toolbar"><span id="rterm-status"></span><button id="rterm-connection"></button><button id="rterm-close"></button></div>
        <iframe id="rterm-frame"></iframe>
      </section>`;
    const api = {
      getRterm: jest
        .fn()
        .mockResolvedValueOnce(snapshot("connected"))
        .mockResolvedValueOnce(snapshot("connected")),
      getRtermEmbedUrl: jest.fn().mockResolvedValue("http://remote.example/provider/ssh?embed=1"),
    };
    (window as unknown as { peskApi: typeof api }).peskApi = api;
    const renderer = setupRtermRenderer();
    await Promise.resolve();
    renderer?.setThread("thread-2");

    expect((document.getElementById("rterm-frame") as HTMLIFrameElement).src).toBe("");
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    document.dispatchEvent(new Event("toggle-rterm"));
    await Promise.resolve();
    await Promise.resolve();

    expect(api.getRterm).toHaveBeenCalledTimes(2);
    expect(api.getRtermEmbedUrl).toHaveBeenCalled();
  });
});

function snapshot(state: RtermSnapshot["state"], authFailed = false): RtermSnapshot {
  return {
    enabled: true,
    state,
    output: "output",
    hostLabel: "remote",
    authFailed,
  };
}
