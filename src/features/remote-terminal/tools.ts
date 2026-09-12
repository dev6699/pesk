import type { DynamicToolSpec } from "../../codex-schema/v2";

export const REMOTE_TERMINAL_NAMESPACE = "remote_terminal" as const;
export const REMOTE_TERMINAL_READ_TOOL = "read" as const;
export const REMOTE_TERMINAL_EXECUTE_TOOL = "execute" as const;

/** Dynamic tools exposed when the Remote Terminal feature is enabled. */
export const REMOTE_TERMINAL_TOOLS = [
  {
    type: "namespace" as const,
    name: REMOTE_TERMINAL_NAMESPACE,
    description: "Tools for the attached remote terminal.",
    tools: [
      {
        type: "function" as const,
        name: REMOTE_TERMINAL_READ_TOOL,
        description: "Read recent output from the attached remote terminal.",
        inputSchema: {
          type: "object",
          properties: { maxLines: { type: "integer", minimum: 1, maximum: 200 } },
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
          properties: { command: { type: "string", minLength: 1 }, reason: { type: "string" } },
          required: ["command"],
          additionalProperties: false,
        },
      },
    ],
  },
] satisfies DynamicToolSpec[];
