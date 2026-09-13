/** @jest-environment jsdom */
/// <reference types="jest" />

import { setupRtermRenderer } from "../../../../src/renderer/features/chat/rterm-renderer";
import { RtermSnapshot } from "../../../../src/features/remote-terminal/rterm-client";

describe("rterm renderer", () => {
  test("forwards provider session lifecycle messages", async () => {
    document.body.innerHTML = `
      <section id="rterm-panel"><div id="rterm-resize-handle"></div>
        <div id="rterm-toolbar"><button id="rterm-refresh"></button><button id="rterm-close"></button></div>
        <iframe id="rterm-frame"></iframe></section>`;
    const api = {
      onRtermChanged: jest.fn(),
      onRtermSessionSelected: jest.fn(),
      getRterm: jest.fn().mockResolvedValue(snapshot("disconnected")),
      getRtermEmbedUrl: jest.fn().mockResolvedValue(""),
      setRtermProviderSession: jest.fn().mockResolvedValue(true),
      clearRtermProviderSession: jest.fn().mockResolvedValue(true),
    };
    (window as unknown as { peskApi: typeof api }).peskApi = api;
    setupRtermRenderer();
    await Promise.resolve();
    window.dispatchEvent(new MessageEvent("message", { data: { source: "other" } }));
    window.dispatchEvent(
      new MessageEvent("message", { data: { source: "rterm", type: "loaded" } }),
    );
    window.dispatchEvent(
      new MessageEvent("message", {
        data: {
          source: "rterm",
          type: "session-ready",
          sessionId: "session-1",
          token: "token-1",
          provider: "ssh",
          target: "host-a",
          user: "user-a",
        },
      }),
    );
    window.dispatchEvent(
      new MessageEvent("message", {
        data: { source: "rterm", type: "disconnected", sessionId: "session-1" },
      }),
    );
    expect(api.setRtermProviderSession).toHaveBeenCalledWith(
      {
        sessionId: "session-1",
        token: "token-1",
        provider: "ssh",
        target: "host-a",
        user: "user-a",
      },
      "standalone",
    );
    expect(api.clearRtermProviderSession).toHaveBeenCalledWith("session-1");
    const panel = document.getElementById("rterm-panel") as HTMLElement;
    const frame = document.getElementById("rterm-frame") as HTMLIFrameElement;
    frame.src = "http://remote.example/provider/ssh?embed=1";
    document.getElementById("rterm-refresh")?.dispatchEvent(new Event("click"));
    document.getElementById("rterm-close")?.dispatchEvent(new Event("click"));
    expect(panel.hidden).toBe(true);
  });

  test("returns no renderer when required markup is missing", () => {
    document.body.innerHTML = "<section id='rterm-panel'></section>";
    expect(setupRtermRenderer()).toBeUndefined();
  });
  test("activates the requested provider session for the current thread", () => {
    document.body.innerHTML = `
      <section id="rterm-panel"><div id="rterm-resize-handle"></div>
        <div id="rterm-toolbar"><button id="rterm-close"></button></div>
        <iframe id="rterm-frame"></iframe></section>`;
    let select: ((selection: { threadId: string; sessionId: string }) => void) | undefined;
    const api = {
      onRtermChanged: jest.fn(),
      onRtermSessionSelected: jest.fn((callback) => {
        select = callback;
      }),
      getRterm: jest.fn().mockResolvedValue(snapshot("disconnected")),
      getRtermEmbedUrl: jest.fn().mockResolvedValue(""),
    };
    (window as unknown as { peskApi: typeof api }).peskApi = api;
    const frame = document.getElementById("rterm-frame") as HTMLIFrameElement;
    const postMessage = jest.spyOn(frame.contentWindow!, "postMessage");
    const renderer = setupRtermRenderer();

    select?.({ threadId: "other-thread", sessionId: "ignored" });
    select?.({ threadId: "standalone", sessionId: "session-1" });
    renderer?.setThread("thread-1");
    select?.({ threadId: "thread-1", sessionId: "session-2" });

    expect(postMessage).toHaveBeenCalledWith(
      { source: "pesk", type: "select-session", sessionId: "session-2" },
      "*",
    );
  });
  test("loads and refreshes the provider iframe", async () => {
    document.body.innerHTML = `
      <section id="rterm-panel" hidden>
        <div id="rterm-resize-handle"></div>
        <div id="rterm-toolbar"><span id="rterm-status"></span><button id="rterm-connection"></button><button id="rterm-close"></button></div>
        <iframe id="rterm-frame"></iframe>
      </section>`;
    const onChanged = jest.fn();
    const callbacks: { changed?: (snapshot: RtermSnapshot) => void } = {};
    onChanged.mockImplementation((callback) => {
      callbacks.changed = callback;
    });
    const api = {
      onRtermChanged: onChanged,
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
    callbacks.changed?.(snapshot("connecting"));
    callbacks.changed?.(snapshot("authenticating", true));
    callbacks.changed?.(snapshot("connected"));
    callbacks.changed?.(snapshot("disconnected"));
    await Promise.resolve();
    const frame = document.getElementById("rterm-frame") as HTMLIFrameElement;
    const source = "http://remote.example/provider/ssh?embed=1";
    expect(frame.src).toBe(source);
    document.getElementById("rterm-refresh")?.dispatchEvent(new Event("click"));
    expect(frame.src).toBe(source);
  });

  test("resizes the panel through the drag handle", () => {
    document.body.innerHTML = `
      <section id="rterm-panel"><div id="rterm-resize-handle"></div>
        <div id="rterm-toolbar"><span id="rterm-status"></span><button id="rterm-connection"></button><button id="rterm-close"></button></div>
        <iframe id="rterm-frame"></iframe></section>`;
    const api = {
      onRtermChanged: jest.fn(),
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

  test("does not post legacy terminal reset messages", () => {
    document.body.innerHTML = `
      <section id="rterm-panel">
        <div id="rterm-resize-handle"></div>
        <div id="rterm-toolbar"><span id="rterm-status"></span><button id="rterm-connection"></button><button id="rterm-close"></button></div>
        <iframe id="rterm-frame"></iframe>
      </section>`;
    const callbacks: { changed?: (snapshot: RtermSnapshot) => void } = {};
    const api = {
      onRtermChanged: jest.fn((callback) => {
        callbacks.changed = callback;
      }),
      getRterm: jest.fn().mockResolvedValue(snapshot("disconnected")),
      getRtermEmbedUrl: jest.fn().mockResolvedValue(""),
    };
    (window as unknown as { peskApi: typeof api }).peskApi = api;
    const frame = document.getElementById("rterm-frame") as HTMLIFrameElement;
    const postMessage = jest.spyOn(frame.contentWindow!, "postMessage");
    setupRtermRenderer();

    callbacks.changed?.(snapshot("connected"));
    callbacks.changed?.({ ...snapshot("connected"), output: "new output" });

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
      onRtermChanged: jest.fn(),
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
    const callbacks: { changed?: (snapshot: RtermSnapshot) => void } = {};
    const api = {
      onRtermChanged: jest.fn((callback) => {
        callbacks.changed = callback;
      }),
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

    callbacks.changed?.(snapshot("connecting"));
    await Promise.resolve();
    expect(api.getRtermEmbedUrl.mock.calls.length).toBeGreaterThan(callsAfterShow);
  });

  test("preserves the initial provider iframe when returning to the first thread", async () => {
    document.body.innerHTML = `
      <section id="rterm-panel" hidden>
        <div id="rterm-resize-handle"></div>
        <div id="rterm-toolbar"><span id="rterm-status"></span><button id="rterm-connection"></button><button id="rterm-close"></button></div>
        <iframe id="rterm-frame"></iframe>
      </section>`;
    const api = {
      onRtermChanged: jest.fn(),
      getRterm: jest.fn().mockResolvedValue(snapshot("disconnected")),
      getRtermEmbedUrl: jest.fn().mockResolvedValue("http://remote.example/provider/ssh?embed=1"),
      setRtermProviderSession: jest.fn(),
      clearRtermProviderSession: jest.fn(),
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
});

function snapshot(state: RtermSnapshot["state"], authFailed = false): RtermSnapshot {
  return { enabled: true, state, output: "output", hostLabel: "remote", authFailed };
}
