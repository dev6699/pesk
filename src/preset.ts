import { screen } from "electron";
import { spawn } from "node:child_process";
import * as path from "node:path";
import { loadRawConfig } from "./config.js";

export interface PresetAction {
  command: string;
  args?: string[];
  monitor?: number;
}

export interface Preset {
  name: string;
  actions: PresetAction[];
}

/** Loads configured Windows presets and launches their actions. */
export class PresetController {
  private readonly presets: Preset[];

  constructor(private readonly debug: (...values: unknown[]) => void) {
    this.presets = this.loadPresets();
  }

  /** Returns the validated presets exposed to the renderer. */
  getPresets(): Preset[] {
    return this.presets;
  }

  /** Runs a configured preset by name and applies monitor placement actions. */
  run(name: string): void {
    const preset = this.presets.find((item) => item.name === name);
    if (!preset) return;

    this.debug("running preset", preset.name);
    for (const action of preset.actions) {
      const child = spawn(
        "cmd.exe",
        ["/d", "/c", "start", "", "/b", action.command, ...(action.args ?? [])],
        { detached: true, stdio: "ignore", windowsHide: true },
      );
      child.unref();
      if (Number.isInteger(action.monitor) && (action.monitor as number) > 0) {
        this.moveProcessToMonitor(action.command, action.monitor as number);
      }
    }
  }

  private loadPresets(): Preset[] {
    try {
      const config = loadRawConfig();
      if (!Array.isArray(config.presets)) return [];
      return config.presets.filter(
        (preset: Preset) =>
          typeof preset?.name === "string" &&
          Array.isArray(preset.actions) &&
          preset.actions.every((action) => typeof action?.command === "string"),
      );
    } catch {
      return [];
    }
  }

  private moveProcessToMonitor(command: string, monitorNumber: number): void {
    const displays = screen.getAllDisplays();
    const display = displays[monitorNumber - 1];
    this.debug(
      "available monitors",
      displays.map((item, index) => ({
        number: index + 1,
        id: item.id,
        bounds: item.bounds,
        workArea: item.workArea,
      })),
    );
    if (!display) {
      this.debug("preset monitor not found", { command, monitorNumber });
      return;
    }

    const processName = path.basename(command).replace(/\.exe$/i, "");
    const escapedProcessName = processName.replace(/'/g, "''");
    const { x, y, width, height } = display.workArea;
    const script = `
    Start-Sleep -Milliseconds 1500
    Add-Type @"
      using System;
      using System.Runtime.InteropServices;
      public static class PeskWindow {
        private delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
        [DllImport("user32.dll")] private static extern bool EnumWindows(EnumWindowsProc callback, IntPtr extraData);
        [DllImport("user32.dll")] private static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);
        [DllImport("user32.dll")] private static extern bool IsWindowVisible(IntPtr hWnd);
        [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr hWnd, IntPtr hWndInsertAfter, int X, int Y, int cx, int cy, uint uFlags);
        public static int MoveProcesses(int[] processIds, int x, int y, int width, int height) {
          int moved = 0;
          EnumWindows((hWnd, extraData) => {
            uint processId;
            GetWindowThreadProcessId(hWnd, out processId);
            if (Array.IndexOf(processIds, (int)processId) >= 0 && IsWindowVisible(hWnd)) {
              SetWindowPos(hWnd, IntPtr.Zero, x, y, width, height, 0x0040);
              moved++;
            }
            return true;
          }, IntPtr.Zero);
          return moved;
        }
      }
"@
    $processIds = @(Get-Process -Name '${escapedProcessName}' -ErrorAction SilentlyContinue |
      Select-Object -ExpandProperty Id)
    if ($processIds.Count -gt 0) {
      $moved = [PeskWindow]::MoveProcesses($processIds, ${x}, ${y}, ${width}, ${height})
      Write-Output "matched_processes=$($processIds.Count) moved_windows=$moved"
    } else {
      Write-Output "matched_processes=0 moved_windows=0"
    }
  `;
    const mover = spawn(
      "powershell.exe",
      ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", script],
      {
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      },
    );
    mover.stdout?.on("data", (data: Buffer) =>
      this.debug("monitor placement output", data.toString().trim()),
    );
    mover.stderr?.on("data", (data: Buffer) =>
      this.debug("monitor placement error", data.toString().trim()),
    );
    mover.on("close", (code) =>
      this.debug("monitor placement finished", {
        command,
        monitorNumber,
        code,
      }),
    );
  }
}
