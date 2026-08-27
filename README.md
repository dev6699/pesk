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
  "webTlsKey": "",
  "webTlsCert": ""
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
- `webTlsKey` and `webTlsCert` optionally enable HTTPS/WSS for the web chat. Relative paths resolve beside the active configuration file; configure both together.
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

Expose only the Codex chat to a browser on the same trusted LAN.

#### Enable access

1. Set `webAccessEnabled` to `true`.
2. Restart Pesk.
3. Open the Pesk Menu and choose `Pair a device`.
4. Enter a unique device name and press Enter.
5. Scan the displayed QR code with the other device’s camera.

The QR code is single-use and expires after five minutes. Each paired device receives its own credential; credentials are not stored in `config.json`.

#### HTTPS and network safety

The endpoint uses HTTP/WebSocket by default and has no internet relay. HTTPS/WSS is required for PWA installation and browser notifications on LAN devices. Configure both `webTlsKey` and `webTlsCert` to enable it.

Do not expose the endpoint through router port forwarding. Use a trusted LAN or a VPN for remote access.

#### Browser notifications

After pairing:

1. Install the chat as a PWA from the browser’s install command, if desired.
2. If the browser asks for permission, choose Allow.
3. If the prompt does not appear, click `Enable notifications` in the chat.
4. If notifications are blocked, allow them in the browser’s site settings and refresh the chat.

`Web Push ready` means that the browser subscription was successfully saved. The indicator is hidden when setup is valid. It does not guarantee that the phone’s operating-system notification settings will display the notification.

Pesk stores:

- `%APPDATA%\pesk\web-devices.json` — paired devices and hashed credentials.
- `%APPDATA%\pesk\web-push-vapid.json` — server VAPID keys.
- `%APPDATA%\pesk\web-push-subscriptions.json` — browser subscriptions, one active subscription per paired device.

In the Pairing menu, Web Push setup status is separate from delivery control. `Enable push`/`Disable push` controls whether Pesk sends updates; it does not grant browser permission or remove the subscription. The web chat is network-only and does not cache the application shell for offline use.

Web Push uses the browser vendor’s delivery service (for example, FCM or APNs) as an outbound dependency. Pesk does not need a public inbound endpoint or a separate notification server. The browser must be able to reach its push service, and Pesk must be able to make outbound HTTPS requests.

To generate a self-signed certificate for local/LAN HTTPS, run the helper from a shell and include the computer’s LAN IP:

```bash
./scripts/generate-tls-cert.sh "$APPDATA/pesk/tls" 192.168.1.23
```

Replace `192.168.1.23` with the computer’s actual LAN IP. The script prints the `webTlsKey` and `webTlsCert` entries to add to the active configuration.

## Repository Layout

- `src/` — Electron main process, controllers, preload bridge, and renderer modules
- `src/renderer/` — separate pet, chat, and menu pages
- `assets/` — application icon and tray artwork
- `tests/` — Jest tests
- `scripts/` — renderer asset-copy helpers
