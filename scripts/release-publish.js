/**
 * Run with: npm run release
 *
 * Publishes v<package-version> by creating and pushing a tag, which starts the
 * GitHub Release workflow. It never pushes commits or branches. Before tagging,
 * it requires a clean, already-pushed master checkout; matching package and lock
 * versions; no existing tag; successful formatting and tests; and an explicit
 * confirmation before it creates or pushes a tag.
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
    fail("an interactive terminal is required to confirm tag publication.");
  }
  const prompt = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await prompt.question(`Publish ${tag}? [y/N] `);
    return /^(y|yes)$/i.test(answer.trim());
  } finally {
    prompt.close();
  }
}

async function main() {
  const packageJson = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
  const lockfile = JSON.parse(fs.readFileSync(path.join(root, "package-lock.json"), "utf8"));
  const version = packageJson.version;
  const tag = `v${version}`;

  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(version)) {
    fail(`package.json version '${version}' is not a valid release version.`);
  }
  if (lockfile.version !== version || lockfile.packages?.[""]?.version !== version) {
    fail("package-lock.json version does not match package.json. Run npm version <version> first.");
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

  run(npmCommand, ["run", "format:check"], { shell: process.platform === "win32" });
  run(npmCommand, ["test"], { shell: process.platform === "win32" });

  if (!(await confirmRelease(tag))) {
    console.log("Release cancelled.");
    return;
  }

  console.log(
    `Creating and pushing ${tag} from ${output("git", ["rev-parse", "--short", "HEAD"])}...`,
  );
  run("git", ["tag", "-a", tag, "-m", `Release ${tag}`]);
  try {
    run("git", ["push", "origin", tag]);
  } catch (error) {
    console.error(`Tag was created locally but was not pushed. Remove it with: git tag -d ${tag}`);
    throw error;
  }
  console.log(`Published ${tag}. GitHub Actions will build and attach the Windows installer.`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
