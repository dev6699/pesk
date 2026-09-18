const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

console.error("[e2e] launcher entered");
const root = path.join(__dirname, "..");
const dependencies = spawnSync(process.execPath, [path.join(__dirname, "ensure-e2e-deps.js")], {
  cwd: root,
  encoding: "utf8",
});
console.error("[e2e] dependency bootstrap result", {
  status: dependencies.status,
  signal: dependencies.signal,
  error: dependencies.error?.message,
  stdout: dependencies.stdout,
  stderr: dependencies.stderr,
});
if (dependencies.error) {
  console.error("E2E dependency bootstrap failed to start:", dependencies.error.message);
  process.exit(1);
}
if (dependencies.status !== 0) process.exit(dependencies.status ?? 1);
const dependencyLines = dependencies.stdout.trim().split(/\r?\n/).filter(Boolean);
const selectedDependencies = dependencyLines.at(-1);
if (!selectedDependencies) {
  console.error("E2E dependency bootstrap did not return a dependency directory.");
  process.exit(1);
}
console.log(`[e2e] using ${selectedDependencies}`);
const env = {
  ...process.env,
  PESK_BUILD_DIR: process.env.PESK_BUILD_DIR || path.join(os.tmpdir(), "pesk-e2e-build"),
  PLAYWRIGHT_OUTPUT_DIR:
    process.env.PLAYWRIGHT_OUTPUT_DIR ||
    (process.env.CI
      ? path.join(root, "test-results")
      : path.join(os.tmpdir(), "pesk-playwright-results")),
};
env.PESK_E2E_NODE_MODULES = selectedDependencies;
env.PESK_ELECTRON_EXECUTABLE = path.join(
  selectedDependencies,
  "electron",
  "dist",
  process.platform === "win32" ? "electron.exe" : "electron",
);
env.NODE_PATH = [selectedDependencies, path.join(root, "node_modules"), process.env.NODE_PATH]
  .filter(Boolean)
  .join(path.delimiter);

const build = spawnSync(process.execPath, [path.join(__dirname, "build.js")], {
  cwd: root,
  env,
  stdio: "inherit",
});
if (build.error) {
  console.error("E2E build failed to start:", build.error.message);
  process.exit(1);
}
if (build.status !== 0) process.exit(build.status ?? 1);
console.log(`[e2e] build ready at ${env.PESK_BUILD_DIR}`);

const buildDirectory = path.resolve(env.PESK_BUILD_DIR);
const runtimeDependencies = path.join(buildDirectory, "node_modules");
if (!fs.existsSync(runtimeDependencies)) {
  fs.symlinkSync(
    selectedDependencies,
    runtimeDependencies,
    process.platform === "win32" ? "junction" : "dir",
  );
}
fs.cpSync(path.join(root, "assets"), path.join(buildDirectory, "assets"), { recursive: true });
fs.writeFileSync(
  path.join(buildDirectory, "config.json"),
  JSON.stringify(
    {
      codexAppServerProfiles: [{ id: "e2e", name: "E2E", url: "ws://127.0.0.1:4500" }],
      activeCodexAppServerProfileId: "e2e",
      features: { remoteTerminal: { enabled: false, url: "" } },
      codexStatusSound: "",
      webAccessEnabled: false,
      webPort: 4587,
      webTlsKey: "",
      webTlsCert: "",
      theme: "amber",
    },
    null,
    2,
  ),
);

const playwright = spawnSync(
  process.execPath,
  [path.join(root, "node_modules", "playwright", "cli.js"), "test", ...process.argv.slice(2)],
  { cwd: root, env, stdio: "inherit" },
);
if (playwright.error) {
  console.error("Unable to start Playwright:", playwright.error.message);
}
process.exit(playwright.status ?? 1);
