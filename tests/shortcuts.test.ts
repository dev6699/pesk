/// <reference types="jest" />

import {
  matchesShortcut,
  SHORTCUTS,
  type ShortcutDefinition,
  type ShortcutId,
} from "../src/renderer/shared/shortcuts";

function event(
  key: string,
  modifiers: Partial<Pick<KeyboardEvent, "ctrlKey" | "altKey" | "shiftKey" | "metaKey">> = {},
): KeyboardEvent {
  return {
    key,
    ctrlKey: false,
    altKey: false,
    shiftKey: false,
    metaKey: false,
    ...modifiers,
  } as KeyboardEvent;
}

test("matches exact shortcut modifiers", () => {
  expect(matchesShortcut(event("Enter", { altKey: true }), "steer")).toBe(true);
  expect(matchesShortcut(event("Enter"), "steer")).toBe(false);
  expect(matchesShortcut(event("Enter", { altKey: true, shiftKey: true }), "steer")).toBe(false);
});

test("supports Ctrl or Cmd shortcuts", () => {
  expect(matchesShortcut(event("c", { ctrlKey: true }), "copyMessage")).toBe(true);
  expect(matchesShortcut(event("c", { metaKey: true }), "copyMessage")).toBe(true);
  expect(matchesShortcut(event("c", { altKey: true }), "copyMessage")).toBe(false);
});

test("keeps Electron accelerator defaults centralized", () => {
  expect(SHORTCUTS.menu.accelerator).toBe("Ctrl+Down");
  expect(SHORTCUTS.petFocus.accelerator).toBe("Ctrl+Up");
});

test.each(Object.keys(SHORTCUTS) as ShortcutId[])("matches the registered definition: %s", (id) => {
  const definition: ShortcutDefinition = SHORTCUTS[id];
  expect(
    matchesShortcut(
      event(definition.key, {
        ctrlKey: definition.ctrl ?? definition.ctrlOrMeta ?? false,
        altKey: definition.alt ?? false,
        shiftKey: definition.shift ?? false,
        metaKey: definition.meta ?? false,
      }),
      id,
    ),
  ).toBe(true);
});

test.each(
  (Object.keys(SHORTCUTS) as ShortcutId[]).filter(
    (id) => !(SHORTCUTS[id] as ShortcutDefinition).ignoreModifiers,
  ),
)("rejects an extra modifier: %s", (id) => {
  const definition: ShortcutDefinition = SHORTCUTS[id];
  expect(
    matchesShortcut(
      event(definition.key, {
        ctrlKey: definition.ctrl ?? definition.ctrlOrMeta ?? false,
        altKey: !(definition.alt ?? false),
        shiftKey: definition.shift ?? false,
        metaKey: definition.meta ?? false,
      }),
      id,
    ),
  ).toBe(false);
});
