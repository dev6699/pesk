<p align="center">
  <img src="assets/pesk-tray.png" alt="Pesk" width="128" />
</p>

# Pesk

Pesk is a lightweight Windows desktop pet built with Electron and TypeScript. It combines an animated, always-on-top companion with a dedicated Codex chat window, keyboard-driven controls, configurable presets, and a system-tray menu.

## Features

- Animated desktop companion with customizable visual themes
- Integrated Codex workspace for interactive development assistance
- Extensible configuration and external content support after installation
- Productivity automation through configurable Windows application presets
- Native Windows integration through the system tray, keyboard shortcuts, and login startup

## Requirements

- Windows for the packaged application and monitor-placement presets
- Node.js and npm for development and packaging

## Development

```bash
npm install
npm start
```

Useful commands:

```bash
npm run build     # Compile main and renderer TypeScript
npm test          # Build and run Jest tests
npm run dist      # Build the Windows NSIS installer
```

Compiled runtime files are written to `build/`. The installer is written to `dist/Pesk-Setup-<version>.exe`.

To open detached DevTools for the pet, chat, and menu windows:

```bash
DESKTOP_PET_DEVTOOLS=1 npm start
```

## Configuration

During development, `config.json` at the repository root provides defaults. The packaged application reads user configuration from:

```text
%APPDATA%\pesk\config.json
```

`config.json` is intentionally excluded from the installer. Complete example:

```json
{
  "fps": 24,
  "speed": 10,
  "petSize": 180,
  "chatWidth": 350,
  "chatHeight": 500,
  "animationsDir": "animations",
  "menuShortcut": "Ctrl+Down",
  "petFocusShortcut": "Ctrl+Up",
  "codexAppServerUrl": "ws://127.0.0.1:4500",
  "codexStatusSound": "audio.mp3",
  "presets": [
    {
      "name": "Open Edge",
      "actions": [
        {
          "command": "msedge",
          "args": ["--new-window", "https://example.com"]
        }
      ]
    },
    {
      "name": "Open YouTube on monitor 2",
      "actions": [
        {
          "command": "brave",
          "args": ["--new-window", "https://www.youtube.com"],
          "monitor": 2
        }
      ]
    },
    {
      "name": "Open Notepad",
      "actions": [
        {
          "command": "notepad.exe",
          "args": ["C:\\Path\\To\\notes.txt"]
        }
      ]
    }
  ],
  "animations": {
    "idle": { "fps": 24 },
    "walk": { "fps": 24 },
    "dance": { "fps": 24 }
  }
}
```

Relative `animationsDir` paths resolve beside the active configuration file. Animation folders contain numbered PNG frames, for example:

`codexStatusSound` is an optional WAV, MP3, or other browser-supported sound-file path, resolved beside the active configuration file. Pesk plays it when Codex changes from working to idle or waiting, unless the pet or chat window is focused. Leave it empty to disable the configured file; the Pet menu can also disable status sounds without changing the path.

```text
%APPDATA%\pesk\animations\dance\001.png
```

Restart Pesk after changing configuration or adding animations. Packaged builds enable Windows login startup after the installed application is launched once.

## Repository Layout

- `src/` — Electron main process, controllers, preload bridge, and renderer modules
- `src/renderer/` — separate pet, chat, and menu pages
- `assets/` — application icon and tray artwork
- `tests/` — Jest tests
- `scripts/` — renderer asset-copy helpers
