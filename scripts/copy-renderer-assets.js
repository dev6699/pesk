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
for (const [from, to] of [
  ["pages/pet.html", "pet.html"],
  ["pages/chat.html", "chat.html"],
  ["pages/web-chat.html", "web-chat.html"],
  ["pages/menu.html", "menu.html"],
  ["styles/styles.css", "styles.css"],
  ["styles/menu.css", "menu.css"],
  ["web/manifest.webmanifest", "manifest.webmanifest"],
  ["web/web-sw.js", "web-sw.js"],
]) {
  fs.copyFileSync(path.join(source, from), path.join(destination, to));
}
fs.copyFileSync(
  path.join(__dirname, "..", "assets", "pesk-tray.png"),
  path.join(destination, "pesk-tray.png"),
);
