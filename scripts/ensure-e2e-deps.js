const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const root = path.join(__dirname, "..");
const cacheDirectory = path.join(root, ".e2e-deps", process.platform);
const packageJson = path.join(root, "package.json");
const packageLock = path.join(root, "package-lock.json");
const fingerprint = crypto
  .createHash("sha256")
  .update(fs.readFileSync(packageJson))
  .update(fs.readFileSync(packageLock))
  .digest("hex");
const marker = path.join(cacheDirectory, ".fingerprint");
const dependenciesDirectory = path.join(cacheDirectory, "node_modules");
const electronBinary = path.join(
  dependenciesDirectory,
  "electron",
  "dist",
  process.platform === "win32" ? "electron.exe" : "electron",
);

if (
  fs.existsSync(dependenciesDirectory) &&
  fs.existsSync(marker) &&
  fs.existsSync(electronBinary) &&
  fs.readFileSync(marker, "utf8") === fingerprint
) {
  process.stdout.write(`${dependenciesDirectory}\n`);
  process.exit(0);
}

fs.mkdirSync(cacheDirectory, { recursive: true });
fs.copyFileSync(packageJson, path.join(cacheDirectory, "package.json"));
fs.copyFileSync(packageLock, path.join(cacheDirectory, "package-lock.json"));
const npm = process.platform === "win32" ? "npm.cmd" : "npm";
console.error(`[e2e-deps] installing platform dependencies in ${cacheDirectory}`);
const result = spawnSync(npm, ["ci", "--no-audit", "--no-fund"], {
  cwd: cacheDirectory,
  stdio: "inherit",
  shell: process.platform === "win32",
});
console.error(`[e2e-deps] npm exited with status ${result.status ?? "null"}`);
if (result.status !== 0) process.exit(result.status ?? 1);
const electronDirectory = path.join(dependenciesDirectory, "electron");
if (!fs.existsSync(electronBinary)) {
  const electronInstall = spawnSync(
    process.execPath,
    [path.join(electronDirectory, "install.js")],
    {
      cwd: electronDirectory,
      stdio: "inherit",
    },
  );
  if (electronInstall.status !== 0) process.exit(electronInstall.status ?? 1);
}
fs.writeFileSync(marker, fingerprint);
process.stdout.write(`${dependenciesDirectory}\n`);
