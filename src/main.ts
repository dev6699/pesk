import { app, Menu } from "electron";
import { PeskApplication } from "./app/application";

const application = new PeskApplication();

app.on("browser-window-created", (_event, window) => {
  window.webContents.on("context-menu", (event, params) => {
    if (params.mediaType !== "image") return;
    event.preventDefault();
    Menu.buildFromTemplate([
      {
        label: "Copy image",
        click: () => window.webContents.copyImageAt(params.x, params.y),
      },
    ]).popup({ window });
  });
});

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
