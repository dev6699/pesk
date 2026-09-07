/** @jest-environment node */
/// <reference types="jest" />
/// <reference types="node" />

import { CodexProjectManager, validProjectId, validProjectRoots } from "../../src/codex/projects";
import type { JsonRpcResponse } from "../../src/codex/protocol";

const project = {
  id: "project-1",
  name: "Workspace",
  roots: [{ path: "/workspace" }],
  metadata: { team: "platform" },
  position: 0,
  createdAt: 1,
  updatedAt: 2,
  recencyAt: null,
};

test("validates project request inputs", () => {
  expect(validProjectId("project-1")).toBe(true);
  expect(validProjectId(" ")).toBe(false);
  expect(validProjectRoots([{ path: "/workspace" }, { path: "C:\\shared" }])).toBe(true);
  expect(validProjectRoots([{ path: "relative" }])).toBe(false);
});

function projectManagerHarness() {
  let nextId = 0;
  let acceptsRequests = true;
  const requests = new Map<number, (message: JsonRpcResponse<unknown>) => void>();
  const sent: Array<{ method: string; params: unknown }> = [];
  const setCommandNotice = jest.fn();
  const setConnectionError = jest.fn();
  const onStateChanged = jest.fn();
  const manager = new CodexProjectManager({
    request: (request, callback) => {
      if (!acceptsRequests) return false;
      const id = ++nextId;
      sent.push(request);
      requests.set(id, callback as (message: JsonRpcResponse<unknown>) => void);
      return true;
    },
    onStateChanged,
    setCommandNotice,
    setConnectionError,
  });
  return {
    manager,
    requests,
    sent,
    setCommandNotice,
    setConnectionError,
    onStateChanged,
    setRequestAccepted: (accepted: boolean) => {
      acceptsRequests = accepted;
    },
  };
}

test("manages the project cache across list pages and reset", async () => {
  const harness = projectManagerHarness();
  const first = harness.manager.listProjects();
  expect(harness.sent[0]).toMatchObject({
    method: "project/list",
    params: { limit: 50, cursor: null },
  });
  harness.requests.get(1)!({ id: 1, result: { data: [project] } });
  await expect(first).resolves.toBe(true);

  const secondProject = { ...project, id: "project-2", name: "Shared" };
  const second = harness.manager.listProjects("cursor-1");
  harness.requests.get(2)!({ id: 2, result: { data: [secondProject] } });
  await expect(second).resolves.toBe(true);
  expect(harness.manager.getProjects()).toEqual([project, secondProject]);
  expect(harness.manager.findProject("project-2")).toEqual(secondProject);

  harness.manager.reset();
  expect(harness.manager.getProjects()).toEqual([]);
});

test("updates and deletes cached projects through app-server responses", async () => {
  jest.useFakeTimers();
  const harness = projectManagerHarness();
  const create = harness.manager.createProject(" Workspace ", ["/workspace"], {}, "key-1");
  expect(harness.sent[0]).toMatchObject({
    method: "project/create",
    params: { name: "Workspace", roots: [{ path: "/workspace" }], idempotencyKey: "key-1" },
  });
  harness.requests.get(1)!({ id: 1, result: { project } });
  await expect(create).resolves.toBe(true);

  const updated = { ...project, name: "Renamed" };
  const update = harness.manager.updateProject("project-1", { name: "Renamed" });
  harness.requests.get(2)!({ id: 2, result: { project: updated } });
  await expect(update).resolves.toBe(true);
  expect(harness.manager.findProject("project-1")).toEqual(updated);

  const move = harness.manager.moveProject("project-1", null);
  expect(harness.sent[2]).toMatchObject({
    method: "project/move",
    params: { projectId: "project-1", beforeProjectId: null },
  });
  harness.requests.get(3)!({ id: 3, result: {} });
  await expect(move).resolves.toBe(true);
  jest.runOnlyPendingTimers();
  harness.requests.get(4)!({ id: 4, result: { data: [updated] } });

  const deletion = harness.manager.deleteProject("project-1");
  harness.requests.get(5)!({ id: 5, result: {} });
  await expect(deletion).resolves.toBe(true);
  expect(harness.manager.getProjects()).toEqual([]);
  jest.useRealTimers();
});

test("handles project commands through the manager", async () => {
  jest.useFakeTimers();
  const harness = projectManagerHarness();
  const managedProject = { ...project, roots: [{ path: "/workspace" }, { path: "/shared" }] };

  expect(harness.manager.manageProject("list")).toBe(true);
  expect(harness.setCommandNotice).toHaveBeenCalledWith("No projects are configured.");
  harness.requests.get(1)!({ id: 1, result: { data: [managedProject] } });
  await Promise.resolve();
  await Promise.resolve();

  const refresh = harness.manager.listProjects();
  harness.requests.get(2)!({ id: 2, result: { data: [managedProject] } });
  await expect(refresh).resolves.toBe(true);
  expect(harness.manager.manageProject("LIST")).toBe(true);
  expect(harness.setCommandNotice).toHaveBeenLastCalledWith(expect.stringContaining("Workspace"));
  harness.requests.get(3)!({ id: 3, result: { data: [managedProject] } });
  await Promise.resolve();

  expect(harness.manager.manageProject("create New Project /new-project")).toBe(true);
  harness.requests.get(4)!({ id: 4, result: { project: managedProject } });
  await Promise.resolve();
  await Promise.resolve();
  expect(harness.manager.manageProject("rename project-1 Renamed")).toBe(true);
  harness.requests.get(5)!({
    id: 5,
    result: { project: { ...managedProject, name: "Renamed" } },
  });
  await Promise.resolve();
  await Promise.resolve();
  expect(harness.manager.manageProject("remove-root project-1 /workspace")).toBe(true);
  harness.requests.get(6)!({ id: 6, result: { project } });
  await Promise.resolve();
  expect(harness.manager.manageProject("delete project-1")).toBe(true);
  harness.requests.get(7)!({ id: 7, result: {} });
  await Promise.resolve();
  expect(harness.manager.manageProject("unknown")).toBe(true);
  expect(harness.setCommandNotice).toHaveBeenLastCalledWith(
    "Usage: /project [list|create <name> <absolute-root>|rename <id> <name>|remove-root <id> <root>|delete <id>]",
  );
  jest.runOnlyPendingTimers();
  jest.useRealTimers();
});

test("reads and imports valid projects", async () => {
  const harness = projectManagerHarness();
  const read = harness.manager.readProject("project-1");
  harness.requests.get(1)!({ id: 1, result: { project } });
  await expect(read).resolves.toBe(true);

  const imported = { ...project, id: "project-2", name: "Imported" };
  const importResult = harness.manager.importProject(
    "Imported",
    ["/workspace"],
    ["thread-1"],
    { team: "platform" },
    "key-2",
  );
  harness.requests.get(2)!({ id: 2, result: { project: imported } });
  await expect(importResult).resolves.toBe(true);
  expect(harness.manager.getProjects()).toEqual([imported]);
});

test("rejects invalid project operation inputs before requesting", async () => {
  const harness = projectManagerHarness();
  await expect(harness.manager.readProject(" ")).resolves.toBe(false);
  await expect(harness.manager.createProject("", ["relative"])).resolves.toBe(false);
  await expect(
    harness.manager.createProject("Project", ["/root"], { team: 1 } as never),
  ).resolves.toBe(false);
  await expect(harness.manager.createProject("Project", ["/root"], {}, " ")).resolves.toBe(false);
  await expect(harness.manager.importProject("Project", ["/root"], [" "])).resolves.toBe(false);
  await expect(harness.manager.importProject("Project", ["relative"], ["thread-1"])).resolves.toBe(
    false,
  );
  await expect(harness.manager.updateProject(" ", {})).resolves.toBe(false);
  await expect(harness.manager.updateProject("project-1", { name: " " })).resolves.toBe(false);
  await expect(harness.manager.updateProject("project-1", { roots: ["relative"] })).resolves.toBe(
    false,
  );
  await expect(
    harness.manager.updateProject("project-1", { metadata: { team: 1 } as never }),
  ).resolves.toBe(false);
  await expect(harness.manager.moveProject(" ", null)).resolves.toBe(false);
  await expect(harness.manager.moveProject("project-1", " ")).resolves.toBe(false);
  await expect(harness.manager.deleteProject(" ")).resolves.toBe(false);
  expect(harness.sent).toHaveLength(0);
});

test("reports malformed and failed project responses", async () => {
  const harness = projectManagerHarness();

  const failedList = harness.manager.listProjects();
  harness.requests.get(1)!({ id: 1, error: "failed" });
  await expect(failedList).resolves.toBe(false);

  const malformedList = harness.manager.listProjects();
  harness.requests.get(2)!({ id: 2, result: { data: [{ id: "invalid" }] } });
  await expect(malformedList).resolves.toBe(false);

  const failedRead = harness.manager.readProject("project-1");
  harness.requests.get(3)!({ id: 3, error: "failed" });
  await expect(failedRead).resolves.toBe(false);

  const malformedRead = harness.manager.readProject("project-1");
  harness.requests.get(4)!({ id: 4, result: { project: { id: "invalid" } } });
  await expect(malformedRead).resolves.toBe(false);

  const failedCreate = harness.manager.createProject("Project", ["/root"], {}, "key");
  harness.requests.get(5)!({ id: 5, error: "failed" });
  await expect(failedCreate).resolves.toBe(false);

  const malformedUpdate = harness.manager.updateProject("project-1", { name: "Updated" });
  harness.requests.get(6)!({ id: 6, result: { project: { id: "invalid" } } });
  await expect(malformedUpdate).resolves.toBe(false);

  const failedDelete = harness.manager.deleteProject("project-1");
  harness.requests.get(7)!({ id: 7, error: "failed" });
  await expect(failedDelete).resolves.toBe(false);
  expect(harness.setConnectionError).toHaveBeenCalledWith("Unable to delete project.");
});

test("resolves false when the project request transport rejects a request", async () => {
  const harness = projectManagerHarness();
  harness.setRequestAccepted(false);

  await expect(harness.manager.listProjects()).resolves.toBe(false);
  expect(harness.sent).toHaveLength(0);
});
