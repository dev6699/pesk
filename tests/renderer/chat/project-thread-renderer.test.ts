/** @jest-environment jsdom */
/// <reference types="jest" />
/// <reference path="../../../src/renderer/shared/types.d.ts" />

import { defaultRendererState } from "../../../src/renderer/shared/default-settings";
import { openProjectThreadPrompt } from "../../../src/renderer/features/chat/project-thread-renderer";

const project = (id = "project-1", name = "Workspace") => ({
  id,
  name,
  roots: [{ path: "/workspace" }, { path: "/shared" }],
  metadata: {},
  position: 0,
  createdAt: 1,
  updatedAt: 1,
  recencyAt: null,
});

function setup(projects = [project()]) {
  const state = defaultRendererState();
  state.codex.projects = projects;
  const api = {
    ...window.peskApi,
    getSettings: jest.fn(() => Promise.resolve(state)),
    startCodexProjectThread: jest.fn(() => Promise.resolve(state)),
    focusCodexInput: jest.fn(),
  } as unknown as Window["peskApi"];
  window.peskApi = api;
  document.body.innerHTML =
    '<form id="codex-chat-form"></form><section id="project-prompt"></section>';
  return { api, state, container: document.getElementById("project-prompt") as HTMLElement };
}

async function submit(form: HTMLFormElement): Promise<void> {
  form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  await Promise.resolve();
  await Promise.resolve();
}

test("selects a project root and starts a new thread", async () => {
  const { api, container } = setup([project(), project("project-2", "Second")]);
  await openProjectThreadPrompt(container);
  const projectSelect = container.querySelector(
    "select[aria-label='Project']",
  ) as HTMLSelectElement;
  const rootSelect = container.querySelector(
    "select[aria-label='Thread root']",
  ) as HTMLSelectElement;
  expect(rootSelect.value).toBe("/workspace");
  projectSelect.value = "project-2";
  projectSelect.dispatchEvent(new Event("change"));
  rootSelect.value = "/shared";
  await submit(container.querySelector("form") as HTMLFormElement);
  expect(api.startCodexProjectThread).toHaveBeenCalledWith("project-2", "/shared");
  expect(container.textContent).toContain("Thread created successfully.");
});

test("defaults to the current thread project and root", async () => {
  const { container, state } = setup([project(), project("project-2", "Second")]);
  state.codex.threadId = "thread-2";
  state.codex.projectId = "project-2";
  state.codex.cwd = "/shared";
  state.codex.threads = [{ id: "thread-2", projectId: "project-2" }];
  await openProjectThreadPrompt(container);
  expect((container.querySelector("select[aria-label='Project']") as HTMLSelectElement).value).toBe(
    "project-2",
  );
  expect(
    (container.querySelector("select[aria-label='Thread root']") as HTMLSelectElement).value,
  ).toBe("/shared");
});

test("infers the current project from the thread cwd", async () => {
  const { container, state } = setup([project(), project("project-2", "Second")]);
  state.codex.threadId = "thread-2";
  state.codex.cwd = "/shared";
  state.codex.threads = [{ id: "thread-2" }];
  await openProjectThreadPrompt(container);
  expect((container.querySelector("select[aria-label='Project']") as HTMLSelectElement).value).toBe(
    "project-1",
  );
  expect(
    (container.querySelector("select[aria-label='Thread root']") as HTMLSelectElement).value,
  ).toBe("/shared");
});

test("reports missing projects, roots, and server errors", async () => {
  const empty = setup([]);
  await openProjectThreadPrompt(empty.container);
  await submit(empty.container.querySelector("form") as HTMLFormElement);
  expect(empty.container.textContent).toContain("Choose a project first.");

  const noRoots = setup([{ ...project(), roots: [] }]);
  await openProjectThreadPrompt(noRoots.container);
  await submit(noRoots.container.querySelector("form") as HTMLFormElement);
  expect(noRoots.container.textContent).toContain("no configured roots");

  const failed = setup();
  (failed.api.startCodexProjectThread as jest.Mock).mockResolvedValue({
    ...failed.state,
    codex: { ...failed.state.codex, error: "start failed" },
  });
  await openProjectThreadPrompt(failed.container);
  await submit(failed.container.querySelector("form") as HTMLFormElement);
  expect(failed.container.textContent).toContain("start failed");
});

test("cancels and restores the composer", async () => {
  const { api, container } = setup();
  await openProjectThreadPrompt(container);
  (
    container.querySelector("button[data-project-thread-cancel='true']") as HTMLButtonElement
  ).click();
  expect(container.hidden).toBe(true);
  expect(document.getElementById("codex-chat-form")?.hidden).toBe(false);
  expect(api.focusCodexInput).toHaveBeenCalled();
});

test("handles a missing composer", async () => {
  const { container } = setup();
  document.getElementById("codex-chat-form")?.remove();
  await openProjectThreadPrompt(container);
  await submit(container.querySelector("form") as HTMLFormElement);
  expect(container.textContent).toContain("Thread created successfully.");
});
