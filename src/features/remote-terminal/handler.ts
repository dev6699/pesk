import type { DynamicToolCallParams, DynamicToolCallResponse } from "../../codex-schema/v2";
import type { RtermClient, RtermSessionsResponse } from "./rterm-client";
import type { DynamicApprovalKind } from "../../codex/dynamic-tools";
import {
  REMOTE_TERMINAL_EXECUTE_TOOL,
  REMOTE_TERMINAL_NAMESPACE,
  REMOTE_TERMINAL_READ_TOOL,
  REMOTE_TERMINAL_SESSIONS_TOOL,
  REMOTE_TERMINAL_UPLOAD_TOOL,
  REMOTE_TERMINAL_DOWNLOAD_TOOL,
} from "./tools";

interface ReadArguments {
  maxLines?: unknown;
  sessionId?: unknown;
}

interface ExecuteArguments {
  command?: unknown;
  reason?: unknown;
  sessionId?: unknown;
}

interface TransferArguments {
  workspacePath?: unknown;
  remotePath?: unknown;
  filename?: unknown;
  sessionId?: unknown;
}

function workspaceFilename(workspacePath: string): string {
  const normalized = workspacePath.replaceAll("\\", "/").replace(/\/+$/, "");
  return normalized.slice(normalized.lastIndexOf("/") + 1) || "upload";
}

function remoteApprovalReason(reason: string, sessionLabel?: string): string {
  return `${sessionLabel ? `[${sessionLabel}]\n` : ""}${reason}`;
}

export interface RemoteTerminalToolHandlerDependencies {
  getRterm: (threadId: string) => RtermClient;
  readWorkspaceFile: (path: string) => Promise<string>;
  writeWorkspaceFile: (path: string, dataBase64: string) => Promise<void>;
  requestApproval: (
    threadId: string,
    callId: string,
    command: string,
    reason: string,
    kind?: DynamicApprovalKind,
    toolName?: string,
  ) => Promise<boolean>;
}

/** Executes Remote Terminal dynamic tools at the application feature boundary. */
export class RemoteTerminalToolHandler {
  constructor(private readonly dependencies: RemoteTerminalToolHandlerDependencies) {}

  async handle(params: DynamicToolCallParams): Promise<DynamicToolCallResponse> {
    const fail = (text: string): DynamicToolCallResponse => ({
      contentItems: [{ type: "inputText", text }],
      success: false,
    });
    if (params.namespace !== REMOTE_TERMINAL_NAMESPACE)
      return fail("Unsupported terminal namespace.");
    if (params.tool === REMOTE_TERMINAL_SESSIONS_TOOL) {
      const response = await this.dependencies.getRterm(params.threadId).requestSessions({
        requestId: params.callId,
      });
      return {
        contentItems: [
          { type: "inputText", text: this.responseText(this.stripSessionTokens(response)) },
        ],
        success: response.ok,
      };
    }
    if (params.tool === REMOTE_TERMINAL_READ_TOOL) {
      const args = this.objectArguments(params.arguments) as ReadArguments;
      const maxLines =
        typeof args?.maxLines === "number" ? Math.min(200, Math.max(1, args.maxLines)) : 200;
      const sessionId = typeof args?.sessionId === "string" ? args.sessionId : undefined;
      const rterm = this.dependencies.getRterm(params.threadId);
      if (sessionId && !rterm.selectProviderSession(sessionId))
        return fail(this.missingSessionMessage(sessionId));
      try {
        const recent = await rterm.readProvider(maxLines, sessionId);
        if (!recent) return fail(this.missingSessionMessage(sessionId));
        return {
          contentItems: [
            {
              type: "inputText",
              text: `${rterm.getSnapshot().hostLabel || "remote shell"}\n${recent.output}${recent.truncated ? "\n[older output omitted]" : ""}`,
            },
          ],
          success: true,
        };
      } catch (error) {
        return fail(
          `Unable to read the provider terminal: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    if (
      params.tool === REMOTE_TERMINAL_UPLOAD_TOOL ||
      params.tool === REMOTE_TERMINAL_DOWNLOAD_TOOL
    ) {
      const args = this.objectArguments(params.arguments) as TransferArguments;
      if (typeof args.workspacePath !== "string" || !args.workspacePath.trim())
        return fail("A workspace path is required.");
      if (typeof args.remotePath !== "string" || !args.remotePath.trim())
        return fail("A remote path is required.");
      if (
        args.filename !== undefined &&
        (typeof args.filename !== "string" || !args.filename.trim())
      )
        return fail("Filename must be a non-empty string.");
      const rterm = this.dependencies.getRterm(params.threadId);
      const sessionId = typeof args.sessionId === "string" ? args.sessionId : undefined;
      if (sessionId && !rterm.selectProviderSession(sessionId))
        return fail(this.missingSessionMessage(sessionId));
      const upload = params.tool === REMOTE_TERMINAL_UPLOAD_TOOL;
      const source = upload ? args.workspacePath : args.remotePath;
      const destination = upload ? args.remotePath : args.workspacePath;
      const approved = await this.dependencies.requestApproval(
        params.threadId,
        params.callId,
        `${upload ? "Upload" : "Download"} ${source} -> ${destination}`,
        remoteApprovalReason("Transfer files.", rterm.getProviderSessionTabLabel(sessionId)),
        "remote",
        `${REMOTE_TERMINAL_NAMESPACE}.${params.tool}`,
      );
      if (!approved) return fail("The user rejected the file transfer.");
      try {
        if (upload) {
          const dataBase64 = await this.dependencies.readWorkspaceFile(args.workspacePath);
          const bytes = await rterm.uploadProviderBytes(
            Uint8Array.from(Buffer.from(dataBase64, "base64")),
            args.remotePath,
            typeof args.filename === "string"
              ? args.filename
              : workspaceFilename(args.workspacePath),
            sessionId,
          );
          if (bytes === undefined) return fail(this.missingSessionMessage(sessionId));
          return {
            contentItems: [{ type: "inputText", text: `Uploaded ${bytes} bytes.` }],
            success: true,
          };
        }
        const data = await rterm.downloadProviderBytes(args.remotePath, sessionId);
        if (!data) return fail(this.missingSessionMessage(sessionId));
        await this.dependencies.writeWorkspaceFile(
          args.workspacePath,
          Buffer.from(data).toString("base64"),
        );
        return {
          contentItems: [{ type: "inputText", text: `Downloaded ${data.byteLength} bytes.` }],
          success: true,
        };
      } catch (error) {
        return fail(
          `Unable to ${upload ? "upload" : "download"} through the provider: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    if (params.tool !== REMOTE_TERMINAL_EXECUTE_TOOL)
      return fail("Unsupported remote terminal tool.");
    const args = this.objectArguments(params.arguments) as ExecuteArguments;
    if (typeof args?.command !== "string" || !args.command.trim())
      return fail("A command is required.");
    const rterm = this.dependencies.getRterm(params.threadId);
    const sessionId = typeof args?.sessionId === "string" ? args.sessionId : undefined;
    if (sessionId && !rterm.selectProviderSession(sessionId))
      return fail(this.missingSessionMessage(sessionId));
    const approved = await this.dependencies.requestApproval(
      params.threadId,
      params.callId,
      args.command,
      typeof args.reason === "string"
        ? remoteApprovalReason(args.reason, rterm.getProviderSessionTabLabel(sessionId))
        : remoteApprovalReason("Run command.", rterm.getProviderSessionTabLabel(sessionId)),
      "remote",
      `${REMOTE_TERMINAL_NAMESPACE}.${params.tool}`,
    );
    if (!approved) return fail("The user rejected the terminal command.");
    try {
      const result = await rterm.executeProvider(args.command, sessionId);
      if (!result) return fail(this.missingSessionMessage(sessionId));
      return {
        contentItems: [
          { type: "inputText", text: `completed; exitCode=${result.exitCode}\n${result.output}` },
        ],
        success: result.exitCode === 0,
      };
    } catch (error) {
      return fail(
        `Unable to execute through the provider: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  private objectArguments(value: DynamicToolCallParams["arguments"]): Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  }

  private responseText(response: RtermSessionsResponse): string {
    if (!response.ok) return response.error || "The rterm request failed.";
    return typeof response.result === "string"
      ? response.result
      : JSON.stringify(response.result ?? {});
  }

  private stripSessionTokens(response: RtermSessionsResponse): RtermSessionsResponse {
    if (!response.ok || !Array.isArray(response.result)) return response;
    return {
      ...response,
      result: response.result.map((session) => {
        if (!session || typeof session !== "object") return session;
        const { token: _token, ...metadata } = session as Record<string, unknown>;
        return metadata;
      }),
    };
  }

  private missingSessionMessage(sessionId?: string): string {
    return sessionId
      ? "The provider session is not connected or does not exist."
      : "The provider session is not connected.";
  }
}
