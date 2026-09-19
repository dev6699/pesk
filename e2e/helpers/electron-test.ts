import { test as base } from "playwright/test";
import { createElectronProfile, removeElectronProfile } from "./electron-profile";

export { expect } from "playwright/test";

export const test = base.extend<{}, { electronProfile: string }>({
  electronProfile: [
    async ({}, use) => {
      const directory = createElectronProfile();
      try {
        await use(directory);
      } finally {
        await removeElectronProfile(directory);
      }
    },
    { scope: "worker" },
  ],
});
