const fs = require("node:fs");
const path = require("node:path");

const source = path.join(__dirname, "..", "src", "renderer");
const destination = path.join(__dirname, "..", "build", "renderer");
fs.mkdirSync(destination, { recursive: true });
for (const file of [
  "pet.html",
  "chat.html",
  "styles.css",
  "menu.html",
  "menu.css",
]) {
  fs.copyFileSync(path.join(source, file), path.join(destination, file));
}
