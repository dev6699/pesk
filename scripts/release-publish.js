/**
 * Run with: npm run release -- <version>
 *
 * Updates package.json and package-lock.json, commits and pushes master, then
 * prints the commands for manually creating and pushing the release tag after
 * CI passes.
 */
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const readline = require("node:readline/promises");

const root = path.resolve(__dirname, "..");
const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";

function run(command, args, options = {}) {
  try {
    return execFileSync(command, args, {
      cwd: root,
      encoding: "utf8",
      stdio: options.stdio ?? "inherit",
      shell: options.shell ?? false,
    });
  } catch (error) {
    process.exitCode = 1;
    const detail = error instanceof Error ? `: ${error.message}` : "";
    throw new Error(`Failed: ${command} ${args.join(" ")}${detail}`, {
      cause: error,
    });
  }
}

function output(command, args) {
  return run(command, args, { stdio: ["ignore", "pipe", "inherit"] }).trim();
}

function fail(message) {
  throw new Error(`Release aborted: ${message}`);
}

async function confirmRelease(tag) {
  if (!process.stdin.isTTY) {
    fail("an interactive terminal is required to confirm the release.");
  }
  const prompt = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await prompt.question(`Prepare ${tag} and push the version commit? [y/N] `);
    return /^(y|yes)$/i.test(answer.trim());
  } finally {
    prompt.close();
  }
}

async function main() {
  const requestedVersion = process.argv[2];
  if (!requestedVersion || process.argv.length > 3) {
    fail("usage: npm run release -- <version> (for example, npm run release -- 1.0.0)");
  }

  const version = requestedVersion;
  const tag = `v${version}`;

  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(version)) {
    fail(`package.json version '${version}' is not a valid release version.`);
  }
  if (output("git", ["status", "--porcelain"])) {
    fail("the working tree is not clean. Commit, stash, or remove every change first.");
  }
  if (output("git", ["branch", "--show-current"]) !== "master") {
    fail("releases must be tagged from master.");
  }

  run("git", ["fetch", "origin", "master", "--tags"]);
  if (output("git", ["rev-parse", "HEAD"]) !== output("git", ["rev-parse", "origin/master"])) {
    fail("HEAD is not the pushed origin/master revision. Push master, wait for CI, then retry.");
  }

  const remoteTags = output("git", ["ls-remote", "--tags", "origin", `refs/tags/${tag}`]);
  if (remoteTags) fail(`remote tag ${tag} already exists.`);
  if (output("git", ["tag", "--list", tag])) fail(`local tag ${tag} already exists.`);

  if (!(await confirmRelease(tag))) {
    console.log("Release cancelled.");
    return;
  }

  run(npmCommand, ["version", version, "--no-git-tag-version"], {
    shell: process.platform === "win32",
  });

  const updatedPackageJson = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
  const lockfile = JSON.parse(fs.readFileSync(path.join(root, "package-lock.json"), "utf8"));
  if (
    updatedPackageJson.version !== version ||
    lockfile.version !== version ||
    lockfile.packages?.[""]?.version !== version
  ) {
    fail("npm version did not update package.json and package-lock.json consistently.");
  }

  run("git", ["add", "package.json", "package-lock.json"]);
  run("git", ["commit", "-m", `Release ${tag}`]);
  run("git", ["push", "origin", "master"]);

  console.log(`Version commit pushed. After master CI passes, create and push ${tag}:`);
  console.log(`  git tag -a ${tag} -m "Release ${tag}"`);
  console.log(`  git push origin ${tag}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
