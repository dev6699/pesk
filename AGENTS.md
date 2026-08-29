# Repository Guidelines

## Project Structure

- `src/main.ts` wires the Electron main process and IPC handlers.
- Main-process controllers live in `src/{chat,config,menu,pet,preset,codex}.ts`.
- Renderer pages and modules live in `src/renderer/`; `pet.html`, `chat.html`, and `menu.html` are separate windows.
- `src/renderer/chat.html` is the Electron desktop chat entry point, while `src/renderer/web-chat.html` is the browser/PWA entry point served by `ChatWebServer`; maintain shared chat markup in both files and verify both when changing the composer or chat UI.
- `assets/` contains the tray icon and bundled fallback artwork.
- `tests/` contains Jest tests, currently focused on Codex behavior.
- `scripts/` contains build-time asset-copy helpers.

## Build, Test, and Development

```bash
npm install       # Install locked dependencies
npm run build     # Compile main and renderer TypeScript and copy page assets
npm start         # Build and launch Electron locally
npm test          # Build, then run Jest serially
npm run dist      # Build a Windows NSIS installer
```

Compiled files go to `build/`; installer artifacts go to `dist/`. Distribute the generated `Pesk-Setup-<version>.exe`, not the build directory.

## Coding Style and Naming

Use TypeScript with strict compiler settings, two-space indentation, semicolons, and double quotes. Run Prettier checks before submitting changes. Use `PascalCase` for classes and interfaces, `camelCase` for functions and variables, and descriptive controller names such as `PetWindowController`. Keep renderer-specific code under `src/renderer/` and communicate with the main process through the typed preload API.

## Testing Guidelines

Tests use Jest with `@swc/jest`; name files `*.test.ts` under `tests/`. Run `npm test` for the normal verification path. TypeScript no-emit checks are useful for read-only environments:

```bash
npx tsc -p tsconfig.json --noEmit
npx tsc -p tsconfig.renderer.json --noEmit
```

Static checks do not prove Windows GUI, installer, or runtime behavior; verify those separately when changing windows, shortcuts, packaging, or startup behavior.

## Configuration and Assets

Development defaults come from the repository `config.json`. Installed-user overrides belong in `%APPDATA%\pesk\config.json`; relative `animationsDir` paths resolve beside that active config. Keep user-editable configuration and external animations out of the packaged executable.

## Commits and Pull Requests

No established commit history is available in this checkout. Use short imperative commit subjects, for example `Extract chat window controller`. Pull requests should describe behavior changes, list verification commands, call out packaging or runtime limitations, and include screenshots for visible UI changes.
