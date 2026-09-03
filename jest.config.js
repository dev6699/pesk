/** @type {import('jest').Config} */
module.exports = {
  transform: {
    "^.+\\.tsx?$": [
      "@swc/jest",
      {
        jsc: {
          parser: {
            syntax: "typescript",
          },
        },
        module: {
          type: "commonjs",
        },
      },
    ],
  },
  testMatch: ["**/tests/**/*.test.ts"],
  moduleNameMapper: {
    "^(\\.{1,2}/shortcuts)\\.js$": "$1",
    "^\\.\\./shared/shortcuts\\.js$": "<rootDir>/src/renderer/shared/shortcuts.ts",
    "^\\.\\./\\.\\./shared/shortcuts\\.js$": "<rootDir>/src/renderer/shared/shortcuts.ts",
    "^\\.\\./\\.\\./shared/theme\\.js$": "<rootDir>/src/renderer/shared/theme.ts",
    "^\\./default-settings\\.js$": "<rootDir>/src/renderer/shared/default-settings.ts",
    "^\\.\\./\\.\\./shared/default-settings\\.js$":
      "<rootDir>/src/renderer/shared/default-settings.ts",
    "^\\./codex-(.*)\\.js$": "<rootDir>/src/renderer/features/chat/codex-$1.ts",
    "^\\./project-manager\\.js$": "<rootDir>/src/renderer/features/chat/project-manager.ts",
    "^\\./project-thread-renderer\\.js$":
      "<rootDir>/src/renderer/features/chat/project-thread-renderer.ts",
  },
};
