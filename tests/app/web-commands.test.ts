/** @jest-environment node */
import { handleWebCommand } from "../../src/app/web-commands";

test.each([
  ["listProjects", []],
  ["readProject", ["project-1"]],
  ["createProject", ["Workspace", ["/workspace"], {}, undefined]],
  ["importProject", ["Workspace", ["/workspace"], ["thread-1"], {}, undefined]],
  ["updateProject", ["project-1", { name: "Renamed" }]],
  ["moveProject", ["project-1", null]],
  ["deleteProject", ["project-1"]],
])("forwards %s through the web command boundary", async (type, args) => {
  const calls: Array<{ method: string; args: unknown[] }> = [];
  const codex = new Proxy({}, { get: (_target, method: string) => (...methodArgs: unknown[]) => { calls.push({ method, args: methodArgs }); return Promise.resolve(true); } }) as never;
  const replies: unknown[] = [];
  const command: Record<string, unknown> = { type, requestId: 1 };
  if (type === "readProject" || type === "deleteProject") command.projectId = args[0];
  if (type === "createProject") Object.assign(command, { name: args[0], root: "/workspace" });
  if (type === "importProject") Object.assign(command, { name: args[0], roots: args[1], threadIds: args[2] });
  if (type === "updateProject") Object.assign(command, { projectId: args[0], changes: args[1] });
  if (type === "moveProject") Object.assign(command, { projectId: args[0], beforeProjectId: args[1] });
  handleWebCommand({ codex, getState: () => ({ state: true } as never) }, command, (reply) => replies.push(reply));
  await new Promise((resolve) => setImmediate(resolve));
  expect(calls[0]?.method).toBe(type.replace("Project", "Project").replace("listProjects", "listProjects"));
  expect(replies).toHaveLength(1);
  expect(replies[0]).toMatchObject({ type: "commandResult", requestId: 1, ok: true });
});
