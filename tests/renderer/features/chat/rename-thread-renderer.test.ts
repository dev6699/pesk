/** @jest-environment jsdom */
/// <reference types="jest" />
/// <reference path="../../../../src/renderer/shared/types.d.ts" />

import { defaultRendererState } from "../../../../src/renderer/shared/default-settings";
import { openRenamePrompt } from "../../../../src/renderer/features/chat/rename-thread-renderer";

function setup() {
  const state = defaultRendererState();
  state.codex.threads.selectedId = "thread-1";
  state.codex.threads.items = [{ id: "thread-1", name: "Existing name", preview: "First prompt" }];
  const api = {
    ...window.peskApi,
    getSettings: jest.fn(() => Promise.resolve(state)),
    renameCodexThread: jest.fn(() => Promise.resolve(state)),
    focusCodexInput: jest.fn(),
  } as unknown as Window["peskApi"];
  window.peskApi = api;
  document.body.innerHTML =
    '<form id="codex-chat-form"></form><section id="thread-prompt"></section>';
  return { api, container: document.getElementById("thread-prompt") as HTMLElement };
}

async function submit(form: HTMLFormElement): Promise<void> {
  form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  await Promise.resolve();
  await Promise.resolve();
}

test("opens with the current name and renames the selected thread", async () => {
  const { api, container } = setup();
  await openRenamePrompt(container);
  const form = container.querySelector("form") as HTMLFormElement;
  const name = container.querySelector("input[type='text']") as HTMLInputElement;

  expect(name.value).toBe("Existing name");
  name.value = "Renamed thread";
  await submit(form);

  expect(api.renameCodexThread).toHaveBeenCalledWith("Renamed thread");
  expect(container.children).toHaveLength(0);
  expect(container.hidden).toBe(true);
  expect(document.getElementById("codex-chat-form")?.hidden).toBe(false);
  expect(api.focusCodexInput).toHaveBeenCalled();
});

test("requires a nonempty thread name", async () => {
  const { api, container } = setup();
  await openRenamePrompt(container);
  const form = container.querySelector("form") as HTMLFormElement;
  const name = container.querySelector("input[type='text']") as HTMLInputElement;
  name.value = "  ";
  await submit(form);

  expect(api.renameCodexThread).not.toHaveBeenCalled();
  expect(container.textContent).toContain("Enter a thread name.");
});
