import type { Project, ProjectRoot, ProjectSortKey } from "../codex-schema/v2";

export type ProjectListParams = {
  cursor?: string | null;
  limit?: number | null;
  sortKey?: ProjectSortKey;
  sortDirection?: "asc" | "desc";
};
export type ProjectListResponse = {
  data: Project[];
  nextCursor?: string | null;
  backwardsCursor?: string | null;
};
export type ProjectReadParams = { projectId: string };
export type ProjectReadResponse = { project: Project };
export type ProjectCreateParams = {
  name: string;
  roots: ProjectRoot[];
  metadata?: { [key: string]: string | undefined };
  idempotencyKey: string;
};
export type ProjectCreateResponse = { project: Project };
export type ProjectImportParams = ProjectCreateParams & { threadIds?: string[] };
export type ProjectImportResponse = { project: Project };
export type ProjectUpdateParams = {
  projectId: string;
  name?: string;
  roots?: ProjectRoot[];
  metadata?: Record<string, string>;
};
export type ProjectUpdateResponse = { project: Project };
export type ProjectMoveParams = { projectId: string; beforeProjectId?: string | null };
export type ProjectMoveResponse = Record<string, never>;
export type ProjectDeleteParams = { projectId: string };
export type ProjectDeleteResponse = Record<string, never>;

export type ProjectRequest =
  | { method: "project/list"; id: number; params: ProjectListParams }
  | { method: "project/read"; id: number; params: ProjectReadParams }
  | { method: "project/create"; id: number; params: ProjectCreateParams }
  | { method: "project/import"; id: number; params: ProjectImportParams }
  | { method: "project/update"; id: number; params: ProjectUpdateParams }
  | { method: "project/move"; id: number; params: ProjectMoveParams }
  | { method: "project/delete"; id: number; params: ProjectDeleteParams };

const absolutePath = (value: unknown): value is string =>
  typeof value === "string" && (value.startsWith("/") || /^[A-Za-z]:[\\/]/.test(value));
const nonEmpty = (value: unknown): value is string =>
  typeof value === "string" && value.trim().length > 0;

export function isProject(value: unknown): value is Project {
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
export function validProjectName(value: unknown): value is string {
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
export function validMetadata(value: unknown): value is Record<string, string> {
  return (
    Boolean(value) &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.entries(value as Record<string, unknown>).every(
      ([key, entry]) => nonEmpty(key) && typeof entry === "string",
    )
  );
}
export function validIdempotencyKey(value: unknown): value is string {
  return nonEmpty(value) && value.length <= 256;
}

export function projectRoots(paths: string[]): ProjectRoot[] {
  return paths.map((path) => ({ path }));
}
