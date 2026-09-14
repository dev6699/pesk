import type { DynamicToolSpec } from "../../codex-schema/v2";

export const REMOTE_TERMINAL_NAMESPACE = "remote_terminal" as const;
export const REMOTE_TERMINAL_READ_TOOL = "read" as const;
export const REMOTE_TERMINAL_EXECUTE_TOOL = "execute" as const;
export const REMOTE_TERMINAL_SESSIONS_TOOL = "sessions" as const;
export const REMOTE_TERMINAL_UPLOAD_TOOL = "upload" as const;
export const REMOTE_TERMINAL_DOWNLOAD_TOOL = "download" as const;

/** Dynamic tools exposed when the Remote Terminal feature is enabled. */
export const REMOTE_TERMINAL_TOOLS = [
  {
    type: "namespace" as const,
    name: REMOTE_TERMINAL_NAMESPACE,
    description: "Tools for the attached remote terminal.",
    tools: [
      {
        type: "function" as const,
        name: REMOTE_TERMINAL_SESSIONS_TOOL,
        description: "List provider terminal sessions available in the current thread.",
        inputSchema: {
          type: "object",
          properties: {},
          additionalProperties: false,
        },
      },
      {
        type: "function" as const,
        name: REMOTE_TERMINAL_READ_TOOL,
        description: "Read recent output from the attached remote terminal.",
        inputSchema: {
          type: "object",
          properties: {
            maxLines: { type: "integer", minimum: 1, maximum: 200 },
            sessionId: { type: "string", minLength: 1 },
          },
          additionalProperties: false,
        },
      },
      {
        type: "function" as const,
        name: REMOTE_TERMINAL_EXECUTE_TOOL,
        description:
          "Request an exact command on the attached remote terminal. The user must approve it.",
        inputSchema: {
          type: "object",
          properties: {
            command: { type: "string", minLength: 1 },
            reason: { type: "string" },
            sessionId: { type: "string", minLength: 1 },
          },
          required: ["command"],
          additionalProperties: false,
        },
      },
      {
        type: "function" as const,
        name: REMOTE_TERMINAL_UPLOAD_TOOL,
        description: "Upload a workspace file to the attached remote terminal after approval.",
        inputSchema: {
          type: "object",
          properties: {
            workspacePath: { type: "string", minLength: 1 },
            remotePath: { type: "string", minLength: 1 },
            filename: { type: "string", minLength: 1 },
            sessionId: { type: "string", minLength: 1 },
          },
          required: ["workspacePath", "remotePath"],
          additionalProperties: false,
        },
      },
      {
        type: "function" as const,
        name: REMOTE_TERMINAL_DOWNLOAD_TOOL,
        description: "Download a remote file to a new workspace file after approval.",
        inputSchema: {
          type: "object",
          properties: {
            remotePath: { type: "string", minLength: 1 },
            workspacePath: { type: "string", minLength: 1 },
            sessionId: { type: "string", minLength: 1 },
          },
          required: ["remotePath", "workspacePath"],
          additionalProperties: false,
        },
      },
    ],
  },
] satisfies DynamicToolSpec[];
