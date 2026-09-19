import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

// Keep only disposable Chromium caches. Everything else may contain test state,
// including future Pesk persistence files and Chromium cookies/local storage.
const reusableCaches = new Set([
  "Cache",
  "Code Cache",
  "GPUCache",
  "DawnGraphiteCache",
  "DawnWebGPUCache",
]);

export function createElectronProfile(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "pesk-e2e-user-"));
}

export async function resetElectronProfile(directory: string): Promise<void> {
  for (const entry of await fs.promises.readdir(directory, { withFileTypes: true })) {
    if (entry.isDirectory() && reusableCaches.has(entry.name)) continue;
    await removeElectronProfile(path.join(directory, entry.name));
  }
}

export async function removeElectronProfile(directory: string): Promise<void> {
  await fs.promises.rm(directory, { recursive: true, force: true });
}
