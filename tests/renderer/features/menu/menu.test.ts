/** @jest-environment jsdom */
/// <reference types="jest" />
/// <reference path="../../../../src/renderer/shared/types.d.ts" />

import { defaultRendererState } from "../../../../src/renderer/shared/default-settings";

const windowEventListeners: Array<{
  type: string;
  listener: EventListenerOrEventListenerObject;
}> = [];

beforeEach(() => {
  const addEventListener = window.addEventListener.bind(window);
  jest.spyOn(window, "addEventListener").mockImplementation((type, listener, options) => {
    windowEventListeners.push({ type, listener });
    addEventListener(type, listener, options);
  });
});

afterEach(() => {
  for (const { type, listener } of windowEventListeners) {
    window.removeEventListener(type, listener);
  }
  windowEventListeners.length = 0;
  jest.restoreAllMocks();
});

test("generates and displays a pairing QR when Enter is pressed in the device name input", async () => {
  jest.useFakeTimers();
  document.body.innerHTML = `
    <main>
      <span id="focus-state"></span><nav id="sections">
        <button data-section="presets"></button><button data-section="animations"></button>
        <button data-section="controls"></button><button data-section="pairing"></button>
      </nav><h2 id="section-title"></h2>
      <section id="presets"><input id="preset-search"><div id="preset-list"></div></section>
      <section id="animations"></section><section id="controls"></section>
      <section id="pairing"><input id="pairing-device-name"><p id="pairing-status" hidden></p>
        <div id="pairing-details" hidden><img id="pairing-qr"><p id="pairing-expiry"></p></div>
        <div id="pairing-devices"></div>
      </section>
    </main>`;
  const createPairing = jest.fn(() =>
    Promise.resolve({
      expiresAt: Date.now() + 300000,
      qrDataUrl: "data:image/png;base64,qr",
      deviceName: "Phone",
    }),
  );
  window.peskApi = {
    getSettings: jest.fn(() => Promise.resolve(defaultRendererState() as never)),
    getAnimations: jest.fn(() => Promise.resolve([])),
    getPresets: jest.fn(() => Promise.resolve([])),
    getPairingDevices: jest.fn(() => Promise.resolve([])),
    createPairing,
    getPairingStatus: jest.fn(() => Promise.resolve({ active: false })),
    onMenuUpdated: jest.fn(),
    onMenuFocusChanged: jest.fn(),
  } as never;
  jest.isolateModules(() => {
    jest.requireActual("../../../../src/renderer/features/menu/menu.ts");
  });
  const input = document.getElementById("pairing-device-name") as HTMLInputElement;
  input.value = "Phone";
  input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" }));
  await Promise.resolve();
  await Promise.resolve();
  expect(createPairing).toHaveBeenCalledWith("Phone");
  expect((document.getElementById("pairing-qr") as HTMLImageElement).src).toBe(
    "data:image/png;base64,qr",
  );
  jest.useRealTimers();
});

test("moves from preset search through preset items with Up and Down", async () => {
  document.body.innerHTML = `
    <main>
      <span id="focus-state"></span><nav id="sections">
        <button data-section="presets"></button><button data-section="animations"></button>
        <button data-section="controls"></button><button data-section="pairing"></button>
      </nav><h2 id="section-title"></h2>
      <section id="presets"><input id="preset-search"><div id="preset-list"></div></section>
      <section id="animations"></section><section id="controls"></section>
      <section id="pairing"><input id="pairing-device-name"><p id="pairing-status" hidden></p>
        <div id="pairing-details" hidden></div><div id="pairing-devices"></div>
      </section>
    </main>`;
  window.peskApi = {
    getSettings: jest.fn(() => Promise.resolve(defaultRendererState() as never)),
    getAnimations: jest.fn(() => Promise.resolve([])),
    getPresets: jest.fn(() => Promise.resolve([{ name: "First" }, { name: "Second" }])),
    getPairingDevices: jest.fn(() => Promise.resolve([])),
    onMenuUpdated: jest.fn(),
    onMenuFocusChanged: jest.fn(),
  } as never;

  jest.isolateModules(() => {
    jest.requireActual("../../../../src/renderer/features/menu/menu.ts");
  });
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));

  const search = document.getElementById("preset-search") as HTMLInputElement;
  const presets = Array.from(document.querySelectorAll<HTMLButtonElement>("#preset-list button"));
  expect(document.activeElement).toBe(search);

  window.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown" }));
  expect(document.activeElement).toBe(presets[0]);
  window.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown" }));
  expect(document.activeElement).toBe(presets[1]);
  window.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowUp" }));
  expect(document.activeElement).toBe(presets[0]);
  window.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowUp" }));
  expect(document.activeElement).toBe(search);
});
