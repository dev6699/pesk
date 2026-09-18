import { app, Menu, net, protocol } from "electron";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { PeskApplication } from "./app/application";

const e2eUserDataPath = process.env.PESK_E2E_USER_DATA_DIR;
if (e2eUserDataPath) app.setPath("userData", path.resolve(e2eUserDataPath));

protocol.registerSchemesAsPrivileged([
  {
    scheme: "pesk",
    privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true },
  },
]);

const application = new PeskApplication();

app.on("browser-window-created", (_event, window) => {
  window.webContents.on("context-menu", (event, params) => {
    if (params.mediaType === "image") {
      event.preventDefault();
      Menu.buildFromTemplate([
        {
          label: "Copy image",
          click: () => window.webContents.copyImageAt(params.x, params.y),
        },
      ]).popup({ window });
      return;
    }

    if (!isEmbeddedRemoteTerminal(params.frameURL)) return;
    event.preventDefault();
    Menu.buildFromTemplate([
      {
        label: "Copy",
        enabled: Boolean(params.selectionText),
        click: () => window.webContents.copy(),
      },
      {
        label: "Paste",
        click: () => window.webContents.paste(),
      },
    ]).popup({ window });
  });
});

function isEmbeddedRemoteTerminal(frameUrl: string): boolean {
  try {
    const url = new URL(frameUrl);
    return url.searchParams.get("embed") === "1" && url.searchParams.get("bridge") === "parent";
  } catch {
    return false;
  }
}

app.whenReady().then(() => {
  protocol.handle("pesk", (request) => {
    const requestUrl = new URL(request.url);
    if (requestUrl.hostname !== "renderer") return new Response("Not found", { status: 404 });
    const rendererRoot = path.resolve(__dirname, "renderer");
    let relativePath: string;
    try {
      relativePath = decodeURIComponent(requestUrl.pathname).replace(/^\/+/, "");
    } catch {
      return new Response("Bad request", { status: 400 });
    }
    const filePath = path.resolve(rendererRoot, relativePath);
    if (filePath !== rendererRoot && !filePath.startsWith(`${rendererRoot}${path.sep}`))
      return new Response("Not found", { status: 404 });
    return net.fetch(pathToFileURL(filePath).toString());
  });
  if (process.platform === "win32" && app.isPackaged) {
    app.setLoginItemSettings({ openAtLogin: true, path: process.execPath });
  }
  application.start();
  if (process.env.PESK_E2E_SHOW_MENU === "1") application.menu.showWindow();
});

app.on("window-all-closed", () => {
  if (process.env.PESK_E2E_USER_DATA_DIR) {
    app.quit();
    return;
  }
  // Keep the tray application alive until the user chooses Quit.
});

app.on("before-quit", () => application.stop());
