import { app, Menu } from "electron";
import { PeskApplication } from "./app/application";

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
  if (process.platform === "win32" && app.isPackaged) {
    app.setLoginItemSettings({ openAtLogin: true, path: process.execPath });
  }
  application.start();
});

app.on("window-all-closed", () => {
  // Keep the tray application alive until the user chooses Quit.
});

app.on("before-quit", () => application.stop());
