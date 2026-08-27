const fs = require("node:fs");
const path = require("node:path");

const source = path.join(__dirname, "..", "src", "renderer");
const destination = path.join(__dirname, "..", "build", "renderer");
fs.mkdirSync(destination, { recursive: true });
fs.mkdirSync(path.join(destination, "vendor"), { recursive: true });
fs.copyFileSync(
  path.join(__dirname, "..", "node_modules", "marked", "lib", "marked.esm.js"),
  path.join(destination, "vendor", "marked.js"),
);
for (const file of [
  "pet.html",
  "chat.html",
  "web-chat.html",
  "styles.css",
  "menu.html",
  "menu.css",
]) {
  fs.copyFileSync(path.join(source, file), path.join(destination, file));
}
