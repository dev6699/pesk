/** @jest-environment jsdom */
/// <reference types="jest" />

import { setupRtermRenderer } from "../../../../src/renderer/features/chat/rterm-renderer";
import { RtermSnapshot } from "../../../../src/features/remote-terminal/rterm-client";

describe("rterm renderer", () => {
  test("bridges terminal state, input, authentication, resize, and connection controls", async () => {
    document.body.innerHTML = `
      <section id="rterm-panel" hidden>
        <div id="rterm-resize-handle"></div>
        <div id="rterm-toolbar"><span id="rterm-status"></span><button id="rterm-connection"></button><button id="rterm-close"></button></div>
        <iframe id="rterm-frame"></iframe>
      </section>`;
    const onChanged = jest.fn();
    const onOutput = jest.fn();
    const callbacks: {
      changed?: (snapshot: RtermSnapshot) => void;
      output?: (data: string) => void;
    } = {};
    onChanged.mockImplementation((callback) => {
      callbacks.changed = callback;
    });
    onOutput.mockImplementation((callback) => {
      callbacks.output = callback;
    });
    const api = {
      onRtermChanged: onChanged,
      onRtermOutput: onOutput,
      getRterm: jest.fn().mockResolvedValue(snapshot("authenticating")),
      getRtermEmbedUrl: jest.fn().mockResolvedValue("http://remote.example/bash?embed=1"),
      toggleRtermConnection: jest.fn().mockResolvedValue(true),
      writeRterm: jest.fn().mockResolvedValue(true),
      authenticateRterm: jest.fn().mockResolvedValue(true),
      resizeRterm: jest.fn().mockResolvedValue(true),
    };
    (window as unknown as { peskApi: typeof api }).peskApi = api;

    setupRtermRenderer();
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
    callbacks.output?.("encoded-output");
    document.getElementById("rterm-frame")?.dispatchEvent(new Event("load"));

    window.dispatchEvent(new MessageEvent("message", { data: { source: "other" } }));
    window.dispatchEvent(
      new MessageEvent("message", { data: { source: "rterm", type: "loaded" } }),
    );
    window.dispatchEvent(
      new MessageEvent("message", { data: { source: "rterm", type: "input", data: "ls\n" } }),
    );
    window.dispatchEvent(
      new MessageEvent("message", {
        data: { source: "rterm", type: "authenticate", code: "123456" },
      }),
    );
    window.dispatchEvent(
      new MessageEvent("message", {
        data: { source: "rterm", type: "terminal-resized", cols: 80, rows: 24 },
      }),
    );
    window.dispatchEvent(
      new MessageEvent("message", {
        data: { source: "rterm", type: "ignored", cols: 0, rows: 0 },
      }),
    );
    document.getElementById("rterm-connection")?.dispatchEvent(new Event("click"));

    expect(api.writeRterm).toHaveBeenCalledWith("ls\n");
    expect(api.authenticateRterm).toHaveBeenCalledWith("123456");
    expect(api.resizeRterm).toHaveBeenCalledWith(80, 24);
    expect(api.toggleRtermConnection).toHaveBeenCalled();
  });

  test("resizes the panel through the drag handle", () => {
    document.body.innerHTML = `
      <section id="rterm-panel"><div id="rterm-resize-handle"></div>
        <div id="rterm-toolbar"><span id="rterm-status"></span><button id="rterm-connection"></button><button id="rterm-close"></button></div>
        <iframe id="rterm-frame"></iframe></section>`;
    const api = {
      onRtermChanged: jest.fn(),
      onRtermOutput: jest.fn(),
      getRterm: jest.fn().mockResolvedValue(snapshot("disconnected")),
      getRtermEmbedUrl: jest.fn().mockResolvedValue(""),
      toggleRtermConnection: jest.fn(),
      writeRterm: jest.fn(),
      authenticateRterm: jest.fn(),
      resizeRterm: jest.fn(),
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

  test("does not reset the terminal for repeated connected output snapshots", () => {
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
      onRtermOutput: jest.fn(),
      getRterm: jest.fn().mockResolvedValue(snapshot("disconnected")),
      getRtermEmbedUrl: jest.fn().mockResolvedValue(""),
      toggleRtermConnection: jest.fn(),
      writeRterm: jest.fn(),
      authenticateRterm: jest.fn(),
      resizeRterm: jest.fn(),
    };
    (window as unknown as { peskApi: typeof api }).peskApi = api;
    const frame = document.getElementById("rterm-frame") as HTMLIFrameElement;
    const postMessage = jest.spyOn(frame.contentWindow!, "postMessage");
    setupRtermRenderer();

    callbacks.changed?.(snapshot("connected"));
    callbacks.changed?.({ ...snapshot("connected"), output: "new output" });

    expect(postMessage.mock.calls.filter(([message]) => message.type === "reset")).toHaveLength(1);
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
      onRtermOutput: jest.fn(),
      getRterm: jest.fn().mockResolvedValue(snapshot("disconnected")),
      getRtermEmbedUrl: jest.fn().mockResolvedValue("http://remote.example/bash?embed=1"),
      toggleRtermConnection: jest.fn(),
      writeRterm: jest.fn(),
      authenticateRterm: jest.fn(),
      resizeRterm: jest.fn(),
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
});

function snapshot(state: RtermSnapshot["state"], authFailed = false): RtermSnapshot {
  return { enabled: true, state, output: "output", hostLabel: "remote", authFailed };
}
