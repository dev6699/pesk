import type { Project, ProjectRoot, ProjectSortKey } from "../codex-schema/v2";
import { randomUUID } from "node:crypto";
import type { JsonRpcResponse } from "./protocol";
import type { CodexProjectsSnapshot } from "./types";

export interface ProjectManagerOptions {
  request: <TResult>(
    request: ProjectRequestInput,
    callback: (message: JsonRpcResponse<TResult>) => void,
  ) => boolean;
  onStateChanged: () => void;
  setCommandNotice: (notice: string) => void;
  setConnectionError: (error: string) => void;
}

type ProjectListParams = {
  cursor?: string | null;
  limit?: number | null;
  sortKey?: ProjectSortKey;
  sortDirection?: "asc" | "desc";
};

type ProjectListResponse = {
  data: Project[];
  nextCursor?: string | null;
  backwardsCursor?: string | null;
};

type ProjectReadParams = {
  projectId: string;
};

type ProjectReadResponse = {
  project: Project;
};

type ProjectCreateParams = {
  name: string;
  roots: ProjectRoot[];
  metadata?: { [key: string]: string | undefined };
  idempotencyKey: string;
};

type ProjectCreateResponse = { project: Project };

type ProjectImportParams = ProjectCreateParams & {
  threadIds?: string[];
};

type ProjectImportResponse = {
  project: Project;
};

type ProjectUpdateParams = {
  projectId: string;
  name?: string;
  roots?: ProjectRoot[];
  metadata?: Record<string, string>;
};

type ProjectUpdateResponse = {
  project: Project;
};

type ProjectMoveParams = {
  projectId: string;
  beforeProjectId?: string | null;
};

type ProjectMoveResponse = Record<string, never>;

type ProjectDeleteParams = {
  projectId: string;
};

type ProjectDeleteResponse = Record<string, never>;

export type ProjectRequest =
  | { method: "project/list"; id: number; params: ProjectListParams }
  | { method: "project/read"; id: number; params: ProjectReadParams }
  | { method: "project/create"; id: number; params: ProjectCreateParams }
  | { method: "project/import"; id: number; params: ProjectImportParams }
  | { method: "project/update"; id: number; params: ProjectUpdateParams }
  | { method: "project/move"; id: number; params: ProjectMoveParams }
  | { method: "project/delete"; id: number; params: ProjectDeleteParams };

export type ProjectRequestInput = {
  [TRequest in ProjectRequest as TRequest["method"]]: Omit<TRequest, "id">;
}[ProjectRequest["method"]];

type ProjectMutationRequest = Extract<
  ProjectRequestInput,
  {
    method: "project/create" | "project/import" | "project/update" | "project/move";
  }
>;

/**
 * Owns app-server project operations and the authoritative project cache.
 *
 * The controller supplies the request helper so this class does not need to
 * know about WebSocket state, JSON-RPC request IDs, or response registration.
 * Thread selection and thread runtime state remain owned by CodexController.
 */
export class CodexProjectManager {
  private projects: Project[] = [];

  constructor(private readonly options: ProjectManagerOptions) {}

  /** Captures projects without exposing the mutable server cache. */
  snapshot(): CodexProjectsSnapshot {
    return { items: structuredClone(this.projects) };
  }

  /** Returns the current server-owned project collection. */
  getProjects(): Project[] {
    return structuredClone(this.projects);
  }

  /** Finds a cached project by its app-server identifier. */
  findProject(projectId: string): Project | undefined {
    return this.projects.find((project) => project.id === projectId);
  }

  /** Clears cached projects when the app-server connection is lost. */
  reset(): void {
    this.projects = [];
  }

  /** Handles the /project command without selecting or changing a thread. */
  manageProject(command: string): boolean {
    const value = command.trim();
    if (!value || value.toLowerCase() === "list") {
      this.options.setCommandNotice(
        this.projects.length
          ? [
              "Projects",
              ...this.projects.map(
                (project, index) =>
                  `${index + 1}. ${project.name} — ${project.roots.map((root) => root.path).join(", ")} (${project.id})`,
              ),
            ].join("\n")
          : "No projects are configured.",
      );
      this.options.onStateChanged();
      void this.listProjects();
      return true;
    }
    const create = value.match(/^create\s+(.+?)\s+((?:[A-Za-z]:[\\/]|\/).+)$/i);
    if (create) {
      void this.createProject(create[1], [create[2]]);
      return true;
    }
    const rename = value.match(/^rename\s+(\S+)\s+(.+)$/i);
    if (rename) {
      void this.updateProject(rename[1], { name: rename[2] });
      return true;
    }
    const removeRoot = value.match(/^remove-root\s+(\S+)\s+(.+)$/i);
    if (removeRoot) {
      const project = this.findProject(removeRoot[1]);
      if (project)
        void this.updateProject(project.id, {
          roots: project.roots.map((root) => root.path).filter((root) => root !== removeRoot[2]),
        });
      return true;
    }
    const remove = value.match(/^delete\s+(\S+)$/i);
    if (remove) {
      void this.deleteProject(remove[1]);
      return true;
    }
    this.options.setCommandNotice(
      "Usage: /project [list|create <name> <absolute-root>|rename <id> <name>|remove-root <id> <root>|delete <id>]",
    );
    this.options.onStateChanged();
    return true;
  }

  /** Loads a project page, replacing or appending to the cached collection. */
  listProjects(cursor: string | null = null): Promise<boolean> {
    return this.request<ProjectListResponse>(
      { method: "project/list", params: { limit: 50, cursor } },
      (message) => {
        const projects = message.result?.data;
        if (message.error || !Array.isArray(projects) || !projects.every(isProject)) {
          this.options.setCommandNotice("Unable to load projects.");
          this.options.onStateChanged();
          return false;
        }
        this.projects = cursor ? [...this.projects, ...projects] : projects;
        this.options.onStateChanged();
        return true;
      },
    );
  }

  /** Defers a full project refresh so notifications do not reorder requests. */
  scheduleRefresh(): void {
    setTimeout(() => {
      this.listProjects();
    }, 0);
  }

  /** Reads one authoritative project and updates its cached entry. */
  readProject(projectId: string): Promise<boolean> {
    if (!validProjectId(projectId)) return Promise.resolve(false);
    return this.request<ProjectReadResponse>(
      { method: "project/read", params: { projectId } },
      (message) => {
        const project = message.result?.project;
        if (message.error || !isProject(project)) {
          this.options.setCommandNotice("Unable to read project.");
          return false;
        }
        this.projects = this.projects.map((entry) => (entry.id === project.id ? project : entry));
        this.options.onStateChanged();
        return true;
      },
    );
  }

  /** Creates a project with validated roots, metadata, and idempotency. */
  createProject(
    name: string,
    roots: string[],
    metadata: Record<string, string> = {},
    idempotencyKey?: string,
  ): Promise<boolean> {
    if (
      !validProjectName(name) ||
      !validProjectRoots(projectRoots(roots)) ||
      !validMetadata(metadata) ||
      (idempotencyKey !== undefined && !validIdempotencyKey(idempotencyKey))
    )
      return Promise.resolve(false);
    return this.projectMutation({
      method: "project/create",
      params: {
        name: name.trim(),
        roots: projectRoots(roots),
        metadata,
        idempotencyKey: idempotencyKey ?? randomUUID(),
      },
    });
  }

  /** Imports a project and optionally assigns existing threads atomically. */
  importProject(
    name: string,
    roots: string[],
    threadIds: string[],
    metadata: Record<string, string> = {},
    idempotencyKey?: string,
  ): Promise<boolean> {
    if (
      !validProjectName(name) ||
      !validProjectRoots(projectRoots(roots)) ||
      !validMetadata(metadata) ||
      (idempotencyKey !== undefined && !validIdempotencyKey(idempotencyKey)) ||
      !threadIds.every(validProjectId)
    )
      return Promise.resolve(false);
    return this.projectMutation({
      method: "project/import",
      params: {
        name: name.trim(),
        roots: projectRoots(roots),
        metadata,
        threadIds,
        idempotencyKey: idempotencyKey ?? randomUUID(),
      },
    });
  }

  /** Updates a project without changing the active thread. */
  updateProject(
    projectId: string,
    changes: { name?: string; roots?: string[]; metadata?: Record<string, string> },
  ): Promise<boolean> {
    if (
      !validProjectId(projectId) ||
      (changes.name !== undefined && !validProjectName(changes.name)) ||
      (changes.roots !== undefined && !validProjectRoots(projectRoots(changes.roots))) ||
      (changes.metadata !== undefined && !validMetadata(changes.metadata))
    )
      return Promise.resolve(false);
    return this.projectMutation({
      method: "project/update",
      params: {
        projectId,
        ...(changes.name === undefined ? {} : { name: changes.name.trim() }),
        ...(changes.roots === undefined ? {} : { roots: projectRoots(changes.roots) }),
        ...(changes.metadata === undefined ? {} : { metadata: changes.metadata }),
      },
    });
  }

  /** Moves a project before another project, or appends it when null. */
  moveProject(projectId: string, beforeProjectId: string | null): Promise<boolean> {
    if (
      !validProjectId(projectId) ||
      (beforeProjectId !== null && !validProjectId(beforeProjectId))
    )
      return Promise.resolve(false);
    return this.projectMutation({
      method: "project/move",
      params: { projectId, beforeProjectId },
    });
  }

  /** Deletes project metadata without deleting threads, roots, or files. */
  deleteProject(projectId: string): Promise<boolean> {
    if (!validProjectId(projectId)) return Promise.resolve(false);
    return this.request<ProjectDeleteResponse>(
      { method: "project/delete", params: { projectId } },
      (message) => {
        if (message.error) {
          this.options.setConnectionError("Unable to delete project.");
          this.options.onStateChanged();
          return false;
        }
        this.projects = this.projects.filter((project) => project.id !== projectId);
        this.options.onStateChanged();
        return true;
      },
    );
  }

  /** Sends a project mutation and updates the cache from its response. */
  private projectMutation(request: ProjectMutationRequest): Promise<boolean> {
    return this.request<
      ProjectCreateResponse | ProjectImportResponse | ProjectUpdateResponse | ProjectMoveResponse
    >(request, (message) => {
      if (request.method === "project/move" && !message.error) {
        this.scheduleRefresh();
        return true;
      }
      const project = message.result?.project;
      if (message.error || !isProject(project)) {
        this.options.setCommandNotice(
          `Unable to ${request.method.slice("project/".length)} project.`,
        );
        this.options.onStateChanged();
        return false;
      }
      const index = this.projects.findIndex((entry) => entry.id === project.id);
      this.projects =
        index < 0
          ? [...this.projects, project]
          : this.projects.map((entry, i) => (i === index ? project : entry));
      this.options.onStateChanged();
      return true;
    });
  }

  /** Correlates one project request through the controller-owned transport. */
  private request<TResult>(
    request: ProjectRequestInput,
    handle: (message: JsonRpcResponse<TResult>) => boolean,
  ): Promise<boolean> {
    return new Promise((resolve) => {
      const accepted = this.options.request<TResult>(request, (message) => {
        resolve(handle(message));
      });
      if (!accepted) resolve(false);
    });
  }
}

const absolutePath = (value: unknown): value is string =>
  typeof value === "string" && (value.startsWith("/") || /^[A-Za-z]:[\\/]/.test(value));
const nonEmpty = (value: unknown): value is string =>
  typeof value === "string" && value.trim().length > 0;

function isProject(value: unknown): value is Project {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const project = value as Record<string, unknown>;
  const roots = project.roots;
  const metadata = project.metadata;
  return (
    nonEmpty(project.id) &&
    nonEmpty(project.name) &&
    Array.isArray(roots) &&
    roots.every(
      (root) =>
        Boolean(root) &&
        typeof root === "object" &&
        absolutePath((root as Record<string, unknown>).path),
    ) &&
    Boolean(metadata) &&
    typeof metadata === "object" &&
    !Array.isArray(metadata) &&
    Object.entries(metadata as Record<string, unknown>).every(
      ([key, value]) => nonEmpty(key) && typeof value === "string",
    ) &&
    typeof project.position === "number" &&
    typeof project.createdAt === "number" &&
    typeof project.updatedAt === "number" &&
    (project.recencyAt === null || typeof project.recencyAt === "number")
  );
}

export function validProjectId(value: unknown): value is string {
  return nonEmpty(value);
}
function validProjectName(value: unknown): value is string {
  return nonEmpty(value);
}
export function validProjectRoots(value: unknown): value is ProjectRoot[] {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.every(
      (root) =>
        Boolean(root) &&
        typeof root === "object" &&
        absolutePath((root as Record<string, unknown>).path),
    )
  );
}
function validMetadata(value: unknown): value is Record<string, string> {
  return (
    Boolean(value) &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.entries(value as Record<string, unknown>).every(
      ([key, entry]) => nonEmpty(key) && typeof entry === "string",
    )
  );
}
function validIdempotencyKey(value: unknown): value is string {
  return nonEmpty(value) && value.length <= 256;
}

function projectRoots(paths: string[]): ProjectRoot[] {
  return paths.map((path) => ({ path }));
}
