import { test, expect } from "playwright/test";
import { ElectronCodexHarness } from "../../helpers/electron-codex";

test.describe("Electron project management", () => {
  let harness: ElectronCodexHarness;

  test.beforeEach(async () => {
    harness = new ElectronCodexHarness();
    await harness.start();
  });

  test.afterEach(async () => harness.dispose());

  test("creates and selects a project thread through the desktop workflow", async () => {
    harness.server.projects.push({
      id: "fixture-project",
      name: "Fixture project",
      roots: [{ path: "/tmp/pesk-e2e-workspace" }],
      metadata: {},
      position: 0,
      createdAt: 1,
      updatedAt: 1,
      recencyAt: null,
    });
    let app = await harness.launch();
    try {
      const chat = await harness.waitForChat(app);
      await expect(chat.locator(".codex-session-trigger")).toContainText("Fixture thread", {
        timeout: 10_000,
      });
      const input = chat.getByRole("textbox", { name: "Message Codex" });
      await input.fill("/new");
      await chat.getByRole("button", { name: "Send" }).click();
      const prompt = chat.locator("#codex-user-input");
      await expect(prompt).toContainText("New project thread");
      await prompt.getByRole("combobox", { name: "Project" }).selectOption("fixture-project");
      await prompt.getByRole("button", { name: "Continue" }).click();
      await expect(chat.locator(".codex-session-trigger")).toContainText("Created thread", {
        timeout: 10_000,
      });
      await chat.locator(".codex-session-trigger").click();
      await expect(chat.locator("#codex-session-menu")).toContainText("Fixture project");
      expect(harness.server.methods).toContain("thread/start");
      expect(
        harness.server.threads.find((thread) => thread.preview === "Created thread")?.projectId,
      ).toBe("fixture-project");

      await app.close();
      const relaunched = await harness.relaunch(app);
      app = relaunched.app;
      const relaunchedChat = relaunched.chat;
      await expect(relaunchedChat.locator(".codex-session-trigger")).toContainText(
        "Fixture thread",
        { timeout: 10_000 },
      );
      await relaunchedChat.locator(".codex-session-trigger").click();
      await expect(relaunchedChat.locator("#codex-session-menu")).toContainText("Created thread");
    } finally {
      await app.close();
    }
  });

  test("manages project roots and deletion through the desktop workflow", async () => {
    const app = await harness.launch();
    try {
      const chat = await harness.waitForChat(app);
      await expect(chat.locator(".codex-session-trigger")).toContainText("Fixture thread", {
        timeout: 10_000,
      });
      await chat.getByRole("textbox", { name: "Message Codex" }).fill("/project");
      await chat.getByRole("button", { name: "Send" }).click();
      const manager = chat.locator("#codex-user-input");
      await expect(manager).toContainText("Project manager");
      await manager.getByRole("textbox", { name: "Name" }).fill("Workspace");
      await manager.getByPlaceholder("Absolute app-server root path").fill("/tmp/workspace");
      await manager.getByRole("button", { name: "Continue" }).click();
      await expect(manager).toContainText("Project created successfully.");

      await manager.getByRole("combobox", { name: "Action" }).selectOption("rename");
      await manager.getByPlaceholder("New name").fill("Renamed workspace");
      await manager.getByRole("button", { name: "Continue" }).click();
      await expect(manager).toContainText("Project updated successfully.");

      await manager.getByRole("combobox", { name: "Action" }).selectOption("add-root");
      await manager.getByPlaceholder("Absolute app-server root path").fill("/tmp/workspace/docs");
      await manager.getByRole("button", { name: "Continue" }).click();
      await expect(manager).toContainText("Project updated successfully.");
      expect(harness.server.projects[0]?.roots.map((root) => root.path)).toEqual([
        "/tmp/workspace",
        "/tmp/workspace/docs",
      ]);

      await manager.getByRole("combobox", { name: "Action" }).selectOption("remove-root");
      await manager
        .getByRole("combobox", { name: "Root to remove" })
        .selectOption("/tmp/workspace/docs");
      await manager.getByRole("button", { name: "Continue" }).click();
      await expect(manager).toContainText("Project updated successfully.");
      expect(harness.server.projects[0]?.roots.map((root) => root.path)).toEqual([
        "/tmp/workspace",
      ]);

      await manager.getByRole("combobox", { name: "Action" }).selectOption("delete");
      await manager.getByRole("button", { name: "Continue" }).click();
      await expect(manager).toContainText("Delete Renamed workspace?");
      await manager.getByRole("button", { name: "Confirm delete" }).click();
      await expect(manager).toContainText("Project deleted successfully.");
      expect(harness.server.projects).toHaveLength(0);
      await expect(manager.getByRole("combobox", { name: "Project", exact: true })).not.toHaveValue(
        "e2e-project-1",
      );
      expect(harness.server.methods).toEqual(
        expect.arrayContaining(["project/create", "project/update", "project/delete"]),
      );
    } finally {
      await app.close();
    }
  });

  test("persists project roots and ordering after relaunch", async () => {
    harness.server.projects.push(
      {
        id: "workspace",
        name: "Workspace",
        roots: [{ path: "/tmp/workspace" }, { path: "/tmp/workspace/docs" }],
        metadata: {},
        position: 0,
        createdAt: 1,
        updatedAt: 1,
        recencyAt: null,
      },
      {
        id: "archive",
        name: "Archive",
        roots: [{ path: "/tmp/archive" }],
        metadata: {},
        position: 1,
        createdAt: 1,
        updatedAt: 1,
        recencyAt: null,
      },
    );
    let app = await harness.launch();
    try {
      let chat = await harness.waitForChat(app);
      await chat.getByRole("textbox", { name: "Message Codex" }).fill("/project");
      await chat.getByRole("button", { name: "Send" }).click();
      let manager = chat.locator("#codex-user-input");
      await expect(manager).toContainText("Project manager");
      await manager.getByRole("combobox", { name: "Project action" }).selectOption("remove-root");
      await manager
        .getByRole("combobox", { name: "Root to remove" })
        .selectOption("/tmp/workspace/docs");
      await manager.getByRole("button", { name: "Continue" }).click();
      await expect(manager).toContainText("Project updated successfully.");

      await manager.getByRole("combobox", { name: "Project action" }).selectOption("add-root");
      await manager.getByPlaceholder("Absolute app-server root path").fill("/tmp/workspace/src");
      await manager.getByRole("button", { name: "Continue" }).click();
      await expect(manager).toContainText("Project updated successfully.");

      await manager.getByRole("combobox", { name: "Project action" }).selectOption("move");
      await manager.getByRole("spinbutton", { name: "Position" }).fill("2");
      await manager.getByRole("button", { name: "Continue" }).click();
      await expect(manager).toContainText("Project moved successfully.");
      expect(harness.server.projects.map((project) => project.name)).toEqual([
        "Archive",
        "Workspace",
      ]);

      await app.close();
      ({ app, chat } = await harness.relaunch(app));
      await chat.getByRole("textbox", { name: "Message Codex" }).fill("/project");
      await chat.getByRole("button", { name: "Send" }).click();
      manager = chat.locator("#codex-user-input");
      await manager.getByRole("combobox", { name: "Project action" }).selectOption("add-root");
      await manager
        .getByRole("combobox", { name: "Project", exact: true })
        .selectOption("workspace");
      await expect(manager).toContainText("/tmp/workspace");
      await expect(manager).toContainText("/tmp/workspace/src");
      await expect(manager).not.toContainText("/tmp/workspace/docs");
      const projects = manager
        .getByRole("combobox", { name: "Project", exact: true })
        .locator("option");
      await expect(projects.nth(0)).toHaveText("Archive");
      await expect(projects.nth(1)).toHaveText("Workspace");
    } finally {
      await app.close();
    }
  });

  test("keeps thread project relationships while switching and after relaunch", async () => {
    harness.server.projects.push(
      {
        id: "project-a",
        name: "Project A",
        roots: [{ path: "/tmp/project-a" }],
        metadata: {},
        position: 0,
        createdAt: 1,
        updatedAt: 1,
        recencyAt: null,
      },
      {
        id: "project-b",
        name: "Project B",
        roots: [{ path: "/tmp/project-b" }],
        metadata: {},
        position: 1,
        createdAt: 1,
        updatedAt: 1,
        recencyAt: null,
      },
    );
    harness.server.threads[0]!.projectId = "project-a";
    harness.server.threads.push(
      {
        id: "project-b-thread",
        preview: "Project B thread",
        cwd: "/tmp/project-b",
        projectId: "project-b",
      },
      {
        id: "project-a-thread",
        preview: "Project A thread",
        cwd: "/tmp/project-a",
        projectId: "project-a",
      },
    );
    let app = await harness.launch();
    try {
      const chat = await harness.waitForChat(app);
      await harness.showChat(app);
      const trigger = chat.locator(".codex-session-trigger");
      await expect(trigger).toContainText("Fixture thread", { timeout: 10_000 });

      await trigger.click();
      const menu = chat.locator("#codex-session-menu");
      const projectBThread = menu.getByRole("option", { name: /Project B thread/ });
      await expect(projectBThread.locator(".codex-session-thread-project")).toContainText(
        "Project B",
      );
      await projectBThread.click();
      await expect(trigger).toContainText("Project B thread");

      await harness.showChat(app);
      await trigger.click();
      const projectAThread = menu.getByRole("option", { name: /Project A thread/ });
      await expect(projectAThread.locator(".codex-session-thread-project")).toContainText(
        "Project A",
      );
      await projectAThread.click();
      await expect(trigger).toContainText("Project A thread");

      await harness.showChat(app);
      await trigger.click();
      await menu.getByRole("option", { name: /Project B thread/ }).click();
      await expect(trigger).toContainText("Project B thread");

      await app.close();
      const relaunched = await harness.relaunch(app);
      app = relaunched.app;
      const relaunchedChat = relaunched.chat;
      const relaunchedTrigger = relaunchedChat.locator(".codex-session-trigger");
      await expect(relaunchedTrigger).toContainText("Fixture thread", { timeout: 10_000 });
      await relaunchedTrigger.click();
      const relaunchedMenu = relaunchedChat.locator("#codex-session-menu");
      await expect(
        relaunchedMenu
          .getByRole("option", { name: /Project A thread/ })
          .locator(".codex-session-thread-project"),
      ).toContainText("Project A");
      await expect(
        relaunchedMenu
          .getByRole("option", { name: /Project B thread/ })
          .locator(".codex-session-thread-project"),
      ).toContainText("Project B");
    } finally {
      await app.close();
    }
  });
});
