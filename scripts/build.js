const { execFileSync } = require("node:child_process");
const path = require("node:path");

const root = path.join(__dirname, "..");
const buildDirectory = path.resolve(root, process.env.PESK_BUILD_DIR || "build");
const tsc = path.join(root, "node_modules", "typescript", "bin", "tsc");

execFileSync(process.execPath, [path.join(__dirname, "clean-build.js")], {
  cwd: root,
  stdio: "inherit",
  env: { ...process.env, PESK_BUILD_DIR: buildDirectory },
});
execFileSync(process.execPath, [tsc, "-p", "tsconfig.json", "--outDir", buildDirectory], {
  cwd: root,
  stdio: "inherit",
});
execFileSync(
  process.execPath,
  [tsc, "-p", "tsconfig.renderer.json", "--outDir", path.join(buildDirectory, "renderer")],
  {
    cwd: root,
    stdio: "inherit",
  },
);
execFileSync(process.execPath, [path.join(__dirname, "copy-renderer-assets.js")], {
  cwd: root,
  stdio: "inherit",
  env: { ...process.env, PESK_BUILD_DIR: buildDirectory },
});
