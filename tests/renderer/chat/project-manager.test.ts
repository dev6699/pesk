/** @jest-environment jsdom */
/// <reference types="jest" />
/// <reference path="../../../src/renderer/shared/types.d.ts" />

import { defaultRendererState } from "../../../src/renderer/shared/default-settings";
import { openProjectManager } from "../../../src/renderer/features/chat/project-manager";

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

function setup() {
  const state = defaultRendererState();
  state.codex.connected = true;
  state.codex.projects = [project(), project("project-2", "Second")];
  const api = {
    ...window.peskApi,
    getSettings: jest.fn(() => Promise.resolve(state)),
    listCodexProjects: jest.fn(() => Promise.resolve(state)),
    createCodexProject: jest.fn(() => Promise.resolve(state)),
    updateCodexProject: jest.fn(() => Promise.resolve(state)),
    moveCodexProject: jest.fn(() => Promise.resolve(state)),
    deleteCodexProject: jest.fn(() => Promise.resolve(state)),
    chooseCodexProjectRoot: jest.fn(() => Promise.resolve("/chosen")),
    setChatFileDialogOpen: jest.fn(),
    focusCodexInput: jest.fn(),
  } as unknown as Window["peskApi"];
  window.peskApi = api;
  document.body.innerHTML =
    '<form id="codex-chat-form"></form><section id="project-prompt"></section>';
  return { api, state, container: document.getElementById("project-prompt") as HTMLElement };
}

function controls(container: HTMLElement) {
  return {
    form: container.querySelector("form") as HTMLFormElement,
    action: container.querySelector("select[aria-label='Project action']") as HTMLSelectElement,
    project: container.querySelector("select[aria-label='Project']") as HTMLSelectElement,
    value: container.querySelectorAll<HTMLInputElement>("input[type='text']")[1],
    position: container.querySelector("input[type='number']") as HTMLInputElement,
    choose: container.querySelector("button[type='button']") as HTMLButtonElement,
    buttons: container.querySelectorAll("button"),
  };
}

async function submit(form: HTMLFormElement): Promise<void> {
  form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  await Promise.resolve();
  await Promise.resolve();
}

beforeEach(() => jest.restoreAllMocks());

test("guides create and folder selection", async () => {
  const { api, container } = setup();
  await openProjectManager(container);
  const controlsSet = controls(container);
  controlsSet.value.value = "/workspace";
  container.querySelectorAll<HTMLInputElement>("input[type='text']")[0].value = "New project";
  await controlsSet.choose.click();
  expect(controlsSet.value.value).toBe("/chosen");
  await submit(controlsSet.form);
  expect(api.createCodexProject).toHaveBeenCalledWith("New project", "/chosen");
  expect(container.textContent).toContain("Project created successfully.");
});

test.each([
  ["rename", "updateCodexProject", "Renamed"],
  ["add-root", "updateCodexProject", "/new-root"],
  ["remove-root", "updateCodexProject", "/shared"],
  ["move", "moveCodexProject", "2"],
])("guides %s and refreshes projects", async (mode, method, value) => {
  const { api, container } = setup();
  await openProjectManager(container);
  const controlsSet = controls(container);
  controlsSet.action.value = mode;
  controlsSet.action.dispatchEvent(new Event("change"));
  if (mode === "move") controlsSet.position.value = value;
  else if (mode === "remove-root") controlsSet.project.dispatchEvent(new Event("change"));
  else controlsSet.value.value = value;
  await submit(controlsSet.form);
  expect((api as unknown as Record<string, jest.Mock>)[method]).toHaveBeenCalled();
  expect(api.listCodexProjects).toHaveBeenCalled();
});

test("requires delete confirmation and supports cancellation", async () => {
  const { api, container } = setup();
  await openProjectManager(container);
  const controlsSet = controls(container);
  controlsSet.action.value = "delete";
  controlsSet.action.dispatchEvent(new Event("change"));
  await submit(controlsSet.form);
  expect(container.textContent).toContain("Delete Workspace?");
  await submit(controlsSet.form);
  expect(api.deleteCodexProject).toHaveBeenCalledWith("project-1");
  controlsSet.buttons[controlsSet.buttons.length - 1].dispatchEvent(new MouseEvent("click"));
  expect(container.hidden).toBe(true);
});

test("shows delete errors and supports moving a project upward", async () => {
  const { api, container, state } = setup();
  (api.deleteCodexProject as jest.Mock).mockResolvedValue({
    ...state,
    codex: { ...state.codex, error: "delete failed" },
  });
  await openProjectManager(container);
  const controlsSet = controls(container);
  controlsSet.action.value = "delete";
  controlsSet.action.dispatchEvent(new Event("change"));
  await submit(controlsSet.form);
  await submit(controlsSet.form);
  expect(container.textContent).toContain("delete failed");

  controlsSet.action.value = "move";
  controlsSet.action.dispatchEvent(new Event("change"));
  controlsSet.project.value = "project-2";
  controlsSet.project.dispatchEvent(new Event("change"));
  controlsSet.position.value = "1";
  await submit(controlsSet.form);
  expect(api.moveCodexProject).toHaveBeenCalledWith("project-2", "project-1");
});

test("handles cancelled folder selection and failed project refresh", async () => {
  const { api, container, state } = setup();
  (api.chooseCodexProjectRoot as jest.Mock).mockResolvedValue(undefined);
  (api.listCodexProjects as jest.Mock).mockResolvedValue({
    ...state,
    codex: { ...state.codex, error: "refresh failed" },
  });
  await openProjectManager(container);
  const controlsSet = controls(container);
  await controlsSet.choose.click();
  expect(api.setChatFileDialogOpen).toHaveBeenNthCalledWith(1, true);
  expect(api.setChatFileDialogOpen).toHaveBeenNthCalledWith(2, false);
  controlsSet.action.value = "add-root";
  controlsSet.action.dispatchEvent(new Event("change"));
  expect(container.textContent).toContain("Roots");
});

test("shows errors and validates missing fields", async () => {
  const { api, container, state } = setup();
  (api.createCodexProject as jest.Mock).mockResolvedValue({
    ...state,
    codex: { ...state.codex, error: "create failed" },
  });
  await openProjectManager(container);
  const controlsSet = controls(container);
  await submit(controlsSet.form);
  expect(container.textContent).toContain("Complete the required field.");
  controlsSet.value.value = "/workspace";
  container.querySelectorAll<HTMLInputElement>("input[type='text']")[0].value = "New";
  await submit(controlsSet.form);
  expect(container.textContent).toContain("create failed");
});

test("handles an empty project list and invalid move positions", async () => {
  const { api, container } = setup();
  const state = defaultRendererState();
  state.codex.connected = true;
  state.codex.projects = [];
  (api.getSettings as jest.Mock).mockResolvedValue(state);
  await openProjectManager(container);
  const controlsSet = controls(container);
  controlsSet.action.value = "delete";
  controlsSet.action.dispatchEvent(new Event("change"));
  await submit(controlsSet.form);
  expect(api.deleteCodexProject).not.toHaveBeenCalled();

  (api.getSettings as jest.Mock).mockResolvedValue({
    ...state,
    codex: { ...state.codex, projects: [project()] },
  });
  await openProjectManager(container);
  const moveControls = controls(container);
  moveControls.action.value = "move";
  moveControls.action.dispatchEvent(new Event("change"));
  moveControls.position.value = "0";
  await submit(moveControls.form);
  expect(container.textContent).toContain("Position must be between");
});

test("cancels without a composer and closes a no-op move", async () => {
  const { api, container } = setup();
  document.getElementById("codex-chat-form")?.remove();
  await openProjectManager(container);
  const controlsSet = controls(container);
  controlsSet.action.value = "move";
  controlsSet.action.dispatchEvent(new Event("change"));
  controlsSet.position.value = "1";
  await submit(controlsSet.form);
  expect(container.hidden).toBe(true);
  expect(api.focusCodexInput).toHaveBeenCalled();
});
