const fs = require("node:fs");
const path = require("node:path");

const buildDirectory = path.resolve(
  path.join(__dirname, ".."),
  process.env.PESK_BUILD_DIR || "build",
);

fs.rmSync(buildDirectory, {
  recursive: true,
  force: true,
});
