import { app } from "electron";
import { PeskApplication } from "./app/application";

const application = new PeskApplication();

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
