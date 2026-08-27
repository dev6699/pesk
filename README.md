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

Pesk uses JSON configuration for application behavior and keeps user preferences in a separate settings file.

- During development, the repository root `config.json` provides the default configuration.
- Installed builds use `%APPDATA%\pesk\config.json` as the user override. The file is created or edited manually; it is intentionally not included in the installer.
- User preferences such as the selected animation, visibility, pause state, and lock state are stored in `%APPDATA%\pesk\settings.json`.

When both configuration files exist, values in the user configuration override the bundled or development defaults. Restart Pesk after changing configuration.

### Application configuration

The following example shows the main supported options:

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
  "webAccessEnabled": false,
  "webPort": 4587,
  "webToken": ""
}
```

Configuration fields:

- `fps`, `speed`, and `petSize` control default animation playback and rendering.
- `chatWidth` and `chatHeight` control the desktop chat window dimensions.
- `animationsDir` selects the external animation directory. Relative paths are resolved beside the active configuration file.
- `menuShortcut` and `petFocusShortcut` define the global keyboard shortcuts.
- `codexAppServerUrl` specifies the Codex app-server WebSocket endpoint.
- `codexStatusSound` specifies an optional sound file. Relative paths are resolved beside the active configuration file.
- `webAccessEnabled` enables the browser-based chat endpoint. It is disabled by default.
- `webPort` specifies the HTTP/WebSocket listening port. The default is `4587`.
- `webToken` specifies the browser access token. If empty, Pesk generates and stores one in `%APPDATA%\pesk\web-token`.
- `presets` defines named Windows commands or URLs available from the Pesk menu. Each action may specify a `command`, `args`, and an optional one-based `monitor`.
- `animations` provides per-animation overrides such as `fps`. Animation folders contain numbered PNG frames, for example:

```text
%APPDATA%\pesk\animations\dance\001.png
```

`codexStatusSound` is an optional sound-file path. Relative paths resolve beside the active configuration file. Leave it empty to disable the sound.

### Presets

Presets define named actions available from the Pesk menu. An action runs a Windows command with optional arguments. URL arguments can be used with browser commands, and `monitor` specifies a one-based monitor number.

```json
{
  "presets": [
    {
      "name": "Open documentation",
      "actions": [
        {
          "command": "msedge",
          "args": ["--new-window", "https://example.com/docs"]
        }
      ]
    },
    {
      "name": "Open dashboard on monitor 2",
      "actions": [
        {
          "command": "brave",
          "args": ["--new-window", "http://localhost:3000"],
          "monitor": 2
        }
      ]
    }
  ]
}
```

Packaged builds enable Windows login startup after the installed application is launched once.

### Browser chat access

To expose only the Codex chat to a browser on the same trusted LAN:

1. Set `webAccessEnabled` to `true`.
2. Set a non-empty `webToken`.
3. Restart Pesk.
4. Open `http://<computer-ip>:<webPort>/?token=<webToken>` on the other device.

The web endpoint is HTTP/WebSocket based, has no internet relay, and should not be exposed through router port forwarding. Use a trusted LAN or a VPN for remote access.

## Repository Layout

- `src/` — Electron main process, controllers, preload bridge, and renderer modules
- `src/renderer/` — separate pet, chat, and menu pages
- `assets/` — application icon and tray artwork
- `tests/` — Jest tests
- `scripts/` — renderer asset-copy helpers
