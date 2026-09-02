# Repository Guidelines

## Project Structure

- `src/main.ts` is the Electron entrypoint and starts `PeskApplication`.
- Application orchestration and IPC registration live in `src/app/`; main-process controllers live in `src/windows/`, `src/services/`, and `src/codex/`, while configuration lives in `src/config/`.
- Renderer pages and modules live in `src/renderer/`; `pet.html`, `chat.html`, and `menu.html` are separate windows.
- `src/renderer/pages/chat.html` is the Electron desktop chat entry point, while `src/renderer/pages/web-chat.html` is the browser/PWA entry point served by `ChatWebServer`; maintain shared chat markup in both files and verify both when changing the composer or chat UI.
- `assets/` contains the tray icon and bundled fallback artwork.
- `tests/` contains Jest tests for app behavior, windows, services, renderers, and Codex behavior.
- `scripts/` contains build cleanup, renderer asset-copy, and TLS certificate helpers.

## Build, Test, and Development

```bash
npm install       # Install locked dependencies
npm run build     # Compile main and renderer TypeScript and copy page assets
npm start         # Build and launch Electron locally
npm test          # Build, then run Jest serially
npm run dist      # Build a Windows NSIS installer
npm run format     # Format supported project files with Prettier
npm run format:check # Verify formatting without changing files
```

Compiled files go to `build/`; installer artifacts go to `dist/`. Distribute the generated `Pesk-Setup-<version>.exe`, not the build directory.

## Coding Style and Naming

Use TypeScript with strict compiler settings. During incremental work, format and check only the changed files with `npx prettier --write <changed-files>` and `npx prettier --check <changed-files>`. Before submitting, run `npm run format` and `npm run format:check` for the full project. Use `PascalCase` for classes and interfaces, `camelCase` for functions and variables, and descriptive controller names such as `PetWindowController`. Keep renderer-specific code under `src/renderer/` and communicate with the main process through the typed preload API.

## Testing Guidelines

Tests use Jest with `@swc/jest`; name files `*.test.ts` under `tests/`. Run `npm test` for the normal verification path. Use TypeScript no-emit checks for type verification, and run formatting and `git diff --check` separately afterward:

```bash
npx tsc -p tsconfig.json --noEmit
npx tsc -p tsconfig.renderer.json --noEmit
```

Static checks do not prove Windows GUI, installer, or runtime behavior; verify those separately when changing windows, shortcuts, packaging, or startup behavior.

## Configuration and Assets

Development defaults come from the repository `config.json`. Installed-user overrides belong in `%APPDATA%\pesk\config.json`; relative `animationsDir` paths resolve beside that active config. Keep user-editable configuration and external animations out of the packaged executable.

## Commits and Pull Requests

No established commit history is available in this checkout. Use short imperative commit subjects, for example `Extract chat window controller`. Pull requests should describe behavior changes, list verification commands, call out packaging or runtime limitations, and include screenshots for visible UI changes.
