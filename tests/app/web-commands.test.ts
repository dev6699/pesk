/** @jest-environment node */
/** @jest-environment jsdom */
/// <reference types="jest" />

import { handleWebCommand } from "../../src/app/web-commands";

test.each([
  ["listProjects", []],
  ["startProjectThread", ["project-1", "/workspace"]],
  ["renameThread", ["Renamed thread"]],
  ["readProject", ["project-1"]],
  ["createProject", ["Workspace", ["/workspace"], {}, undefined]],
  ["importProject", ["Workspace", ["/workspace"], ["thread-1"], {}, undefined]],
  ["updateProject", ["project-1", { name: "Renamed" }]],
  ["moveProject", ["project-1", null]],
  ["deleteProject", ["project-1"]],
])("forwards %s through the web command boundary", async (type, args) => {
  const calls: Array<{ method: string; args: unknown[] }> = [];
  const codex = new Proxy(
    {},
    {
      get:
        (_target, method: string) =>
        (...methodArgs: unknown[]) => {
          calls.push({ method, args: methodArgs });
          return method === "startProjectThread" || method === "renameThread"
            ? true
            : Promise.resolve(true);
        },
    },
  ) as never;
  const replies: unknown[] = [];
  const command: Record<string, unknown> = { type, requestId: 1 };
  if (type === "readProject" || type === "deleteProject") command.projectId = args[0];
  if (type === "startProjectThread") Object.assign(command, { projectId: args[0], cwd: args[1] });
  if (type === "renameThread") Object.assign(command, { name: args[0] });
  if (type === "createProject") Object.assign(command, { name: args[0], root: "/workspace" });
  if (type === "importProject")
    Object.assign(command, { name: args[0], roots: args[1], threadIds: args[2] });
  if (type === "updateProject") Object.assign(command, { projectId: args[0], changes: args[1] });
  if (type === "moveProject")
    Object.assign(command, { projectId: args[0], beforeProjectId: args[1] });
  handleWebCommand(
    {
      codex,
      getState: () => ({ state: true }) as never,
      remoteTerminal: {} as never,
      getRtermEmbedUrl: async () => "",
    },
    command,
    (reply) => replies.push(reply),
  );
  await new Promise((resolve) => setImmediate(resolve));
  expect(calls[0]?.method).toBe(
    type.replace("Project", "Project").replace("listProjects", "listProjects"),
  );
  expect(replies).toHaveLength(1);
  expect(replies[0]).toMatchObject({ type: "commandResult", requestId: 1, ok: true });
});

test("forwards a valid rterm sessions response and rejects malformed responses", () => {
  const handleSessionsResponse = jest.fn();
  const context = {
    codex: {} as never,
    getState: () => ({ state: true }) as never,
    remoteTerminal: { handleSessionsResponse } as never,
    getRtermEmbedUrl: async () => "",
  };
  const replies: unknown[] = [];

  handleWebCommand(
    context,
    {
      type: "rtermSessionsResponse",
      requestId: 4,
      threadId: "thread-1",
      response: { requestId: "call-1", ok: true, result: [] },
    },
    (reply) => replies.push(reply),
  );
  handleWebCommand(
    context,
    {
      type: "rtermSessionsResponse",
      requestId: 5,
      threadId: "thread-1",
      response: { requestId: 7, ok: "yes" },
    },
    (reply) => replies.push(reply),
  );

  expect(handleSessionsResponse).toHaveBeenCalledWith("thread-1", {
    requestId: "call-1",
    ok: true,
    result: [],
  });
  expect(replies).toEqual([
    expect.objectContaining({ type: "commandResult", requestId: 4, ok: true }),
    expect.objectContaining({ type: "commandResult", requestId: 5, ok: false }),
  ]);
});
