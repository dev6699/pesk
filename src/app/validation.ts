export type RequestId = string | number;

export interface ImageInput {
  url: string;
  name: string;
}

export function isRequestId(value: unknown): value is RequestId {
  return typeof value === "string" || typeof value === "number";
}

export function validImageInputs(value: unknown): ImageInput[] {
  if (!Array.isArray(value)) return [];
  return value.filter((image): image is ImageInput => {
    if (!image || typeof image !== "object") return false;
    const record = image as Record<string, unknown>;
    return (
      typeof record.url === "string" &&
      record.url.startsWith("data:image/") &&
      typeof record.name === "string"
    );
  });
}

export function validRoots(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.filter((root): root is string => typeof root === "string");
}

export function validAnswers(value: unknown): Record<string, string[]> | undefined {
  if (!value || typeof value !== "object") return undefined;
  return Object.fromEntries(
    Object.entries(value).flatMap(([id, answer]) =>
      Array.isArray(answer)
        ? [[id, answer.filter((item): item is string => typeof item === "string")]]
        : [],
    ),
  );
}
