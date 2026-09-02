/** @jest-environment node */
import {
  isProject,
  projectRoots,
  validIdempotencyKey,
  validMetadata,
  validProjectId,
  validProjectName,
  validProjectRoots,
} from "../../src/codex/projects";

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

test("validates the complete project response shape", () => {
  expect(isProject(project)).toBe(true);
  expect(isProject({ ...project, roots: [{ path: "relative" }] })).toBe(false);
  expect(isProject({ ...project, metadata: { team: 1 } })).toBe(false);
  expect(isProject({ ...project, recencyAt: "now" })).toBe(false);
});

test("validates project request inputs", () => {
  expect(validProjectId("project-1")).toBe(true);
  expect(validProjectId(" ")).toBe(false);
  expect(validProjectName("Workspace")).toBe(true);
  expect(validProjectName("")).toBe(false);
  expect(validProjectRoots(projectRoots(["/workspace", "C:\\shared"]))).toBe(true);
  expect(validProjectRoots(projectRoots(["relative"]))).toBe(false);
  expect(validMetadata({ team: "platform" })).toBe(true);
  expect(validMetadata({ team: 1 })).toBe(false);
  expect(validIdempotencyKey("request-1")).toBe(true);
  expect(validIdempotencyKey(" ")).toBe(false);
});
