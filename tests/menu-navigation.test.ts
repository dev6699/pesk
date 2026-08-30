/** @jest-environment jsdom */
/// <reference types="jest" />
/// <reference path="../src/renderer/types.d.ts" />

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
    getSettings: jest.fn(() =>
      Promise.resolve({
        animation: "idle",
        animationMode: "selected",
        paused: false,
        locked: false,
        visible: true,
        codexStatusSound: true,
      } as never),
    ),
    getAnimations: jest.fn(() => Promise.resolve([])),
    getPresets: jest.fn(() => Promise.resolve([{ name: "First" }, { name: "Second" }])),
    getPairingDevices: jest.fn(() => Promise.resolve([])),
    onMenuUpdated: jest.fn(),
    onMenuFocusChanged: jest.fn(),
  } as never;

  jest.isolateModules(() => {
    jest.requireActual("../src/renderer/menu.ts");
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
