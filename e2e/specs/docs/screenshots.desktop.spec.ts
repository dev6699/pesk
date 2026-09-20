import { readFileSync } from "node:fs";
import path from "node:path";
import { test, expect } from "../../helpers/electron-test";
import { ElectronCodexHarness } from "../../helpers/electron-codex";
import { FakeRtermServer } from "../../servers/rterm/server";

const docsDirectory = path.resolve("docs");
const imageGenerationFixture = `data:image/png;base64,${readFileSync(
  path.join(docsDirectory, "imagegen-fixture.png"),
).toString("base64")}`;

async function resizeWindow(
  app: Awaited<ReturnType<ElectronCodexHarness["launch"]>>,
  filename: string,
  width: number,
  height: number,
): Promise<void> {
  await app.evaluate(
    ({ BrowserWindow }, bounds: { filename: string; width: number; height: number }) => {
      const window = BrowserWindow.getAllWindows().find((candidate) =>
        candidate.webContents.getURL().includes(bounds.filename),
      );
      window?.setSize(bounds.width, bounds.height);
    },
    { filename, width, height },
  );
}

test.describe("@docs documentation screenshots", () => {
  let harness: ElectronCodexHarness;
  let rterm: FakeRtermServer;

  test.beforeEach(async ({ electronProfile }) => {
    rterm = new FakeRtermServer();
    await rterm.ready();
    harness = new ElectronCodexHarness(electronProfile);
    await harness.start();
    const thread = harness.server.threads[0];
    if (thread) {
      thread.name = "Release operations";
      thread.preview = "Release operations";
      thread.turns = [
        {
          id: "release-triage-turn",
          startedAt: 1,
          status: "completed",
          items: [
            {
              id: "release-triage-user",
              type: "userMessage",
              content: [{ type: "text", text: "What should we verify before publishing?" }],
            },
            {
              id: "release-triage-assistant",
              type: "agentMessage",
              text: "I will check CI, the installer artifact, release notes, and production health before recommending publication.",
              phase: null,
              memoryCitation: null,
              delivery: null,
              questions: null,
            },
          ],
        },
      ];
    }
    harness.writeConfig({
      chatWidth: 640,
      chatHeight: 800,
      features: { remoteTerminal: { enabled: true, url: rterm.url } },
    });
    harness.server.setDisplayIdentity({
      model: "pesk-code-69",
      provider: "Pesk AI",
      cliVersion: "0.9.4",
    });
    harness.server.setApprovalCommand("systemctl status pesk --no-pager");
  });

  test.afterEach(async () => {
    await harness.dispose();
    await rterm.close();
  });

  test("captures the primary Codex workspace", async () => {
    harness.server.setThreadResponse(
      harness.server.threads[0]!.id,
      [
        "## Release readiness review",
        "",
        "The Windows release candidate is ready for the final verification pass.",
        "",
        "### Verification summary",
        "",
        "- CI checks are green across the application and Electron workflows",
        "- The installer is built from the tagged package version",
        "- Remote host diagnostics remain approval-gated",
        "- Playwright traces and screenshots are retained for failures",
        "",
        "### Recommended next steps",
        "",
        "1. Confirm the release notes describe the user-visible changes.",
        "2. Upload the installer and Playwright report to the release record.",
        "3. Approve the final health check on the production host.",
        "",
        "I recommend publishing after the release notes and artifact checks are complete.",
      ].join("\n"),
    );
    const app = await harness.launch();
    const chat = await harness.waitForChat(app);
    await resizeWindow(app, "chat.html", 640, 800);
    await expect.poll(() => chat.evaluate(() => innerWidth)).toBeGreaterThan(500);
    const input = chat.getByRole("textbox", { name: "Message Codex" });
    await input.fill("Review the Windows release candidate and summarize its readiness.");
    await input.press("Enter");
    await expect(chat.locator("#codex-history-content")).toContainText("Release readiness review");
    await input.fill("/");
    await expect(chat.locator(".codex-command-suggestion")).toHaveCount(14);
    await expect(chat.locator(".codex-command-suggestion").first()).toContainText("/plan");
    await chat.screenshot({ path: path.join(docsDirectory, "screenshot-workspace.png") });
  });

  test("captures the thread-wide file change review", async () => {
    harness.server.enableFileChangeSequence([
      [
        {
          kind: "modified",
          path: "src/windows/chat-window.ts",
          diff: "@@ -118,3 +118,7 @@\n-  window.hide();\n+  window.show();\n+  window.focus();\n+  window.webContents.focus();",
        },
        {
          kind: "modified",
          path: ".github/workflows/release.yml",
          diff: "@@ -24,2 +24,6 @@\n       - run: npm test\n+      - run: npx playwright install chromium\n+      - run: npm run test:e2e\n+        env:\n+          CI: true",
        },
      ],
      [
        {
          kind: "added",
          path: "docs/release-checklist.md",
          diff: "@@ -0,0 +1,4 @@\n+# Release checklist\n+\n+- Verify the tag and installer\n+- Review Playwright artifacts",
        },
        {
          kind: "modified",
          path: "src/services/release-health.ts",
          diff: "@@ -42,2 +42,4 @@\n-  return response.ok;\n+  return response.ok && response.status < 500;\n+}\n+\n+export const releaseHealthTimeoutMs = 15000;",
        },
      ],
      [
        {
          kind: "modified",
          path: "README.md",
          diff: "@@ -8,2 +8,5 @@\n Pesk is an Electron and TypeScript application for working with Codex.\n+\n+## Release workflow\n+\n+Every tagged release runs the Electron E2E suite before packaging.",
        },
      ],
    ]);
    const app = await harness.launch();
    const chat = await harness.waitForChat(app);
    await resizeWindow(app, "chat.html", 640, 800);
    await expect.poll(() => chat.evaluate(() => innerWidth)).toBeGreaterThan(500);
    const input = chat.getByRole("textbox", { name: "Message Codex" });
    for (const [index, prompt] of [
      "Review the application and release workflow changes.",
      "Add the health-check and release documentation updates.",
      "Summarize the final documentation change.",
    ].entries()) {
      await input.fill(prompt);
      await input.press("Enter");
      await expect(chat.locator(".codex-file-change-details")).toHaveCount(index + 1);
    }
    await expect(chat.locator("#codex-changes-toggle")).toBeEnabled();
    await chat.locator("#codex-changes-toggle").click();
    const changesPanel = chat.locator("#codex-changes-panel");
    await expect(changesPanel).toBeVisible();
    const changeTurns = changesPanel.locator(".codex-changes-turn");
    await expect(changeTurns).toHaveCount(3);
    await changeTurns.nth(1).locator("summary").click();
    await chat.screenshot({ path: path.join(docsDirectory, "screenshot-file-changes.png") });
  });

  test("captures an image-generation activity", async () => {
    const thread = harness.server.threads[0];
    if (!thread) throw new Error("Documentation screenshot thread is missing");
    harness.server.projects.push(
      {
        id: "pesk-desktop",
        name: "Pesk Desktop",
        roots: [{ path: "/workspaces/pesk" }, { path: "/workspaces/pesk/rterm" }],
        metadata: { owner: "Release engineering" },
        position: 0,
        createdAt: 1,
        updatedAt: 2,
        recencyAt: 2,
      },
      {
        id: "release-docs",
        name: "Release documentation",
        roots: [{ path: "/workspaces/pesk/docs" }],
        metadata: { owner: "Product operations" },
        position: 1,
        createdAt: 1,
        updatedAt: 2,
        recencyAt: 1,
      },
    );
    thread.turns = [
      {
        id: "image-generation-turn",
        startedAt: 1,
        status: "completed",
        items: [
          {
            id: "image-generation-user",
            type: "userMessage",
            content: [{ type: "text", text: "Create a visual summary of the release workflow." }],
          },
          {
            id: "image-generation-result",
            type: "imageGeneration",
            status: "completed",
            result: imageGenerationFixture,
          },
        ],
      },
    ];
    const app = await harness.launch();
    const chat = await harness.waitForChat(app);
    await resizeWindow(app, "chat.html", 640, 800);
    await expect.poll(() => chat.evaluate(() => innerWidth)).toBeGreaterThan(500);
    await expect(chat.locator(".codex-activity-image")).toBeVisible();
    await expect(chat.locator(".codex-activity-image")).toHaveAttribute("alt", "Generated image");
    const input = chat.getByRole("textbox", { name: "Message Codex" });
    await input.fill("/project");
    await chat.getByRole("button", { name: "Send" }).click();
    const projectManager = chat.locator(".codex-project-manager-form");
    await expect(projectManager).toBeVisible();
    await expect(projectManager).toContainText("Project manager");
    await expect(projectManager).toContainText("/workspaces/pesk");
    await chat.screenshot({ path: path.join(docsDirectory, "screenshot-imagegen.png") });
  });

  test("captures human approval for a remote diagnostic command", async () => {
    harness.server.enableRemoteTerminal();
    harness.server.setRemoteCommand(
      "cat /etc/os-release",
      "Read the remote host version before the release check.",
    );
    const app = await harness.launch();
    const chat = await harness.waitForChat(app);
    await resizeWindow(app, "chat.html", 640, 800);
    await expect.poll(() => chat.evaluate(() => innerWidth)).toBeGreaterThan(500);
    const input = chat.getByRole("textbox", { name: "Message Codex" });
    await input.fill("/rterm");
    await chat.getByRole("button", { name: "Send" }).click();
    await expect(chat.locator("#rterm-panel")).toBeVisible();
    await expect(chat.frameLocator("#rterm-frame").locator("#fake-rterm")).toHaveText("Fake rterm");
    await input.fill("Check the remote host version before publishing.");
    await input.press("Enter");
    const approval = chat.locator("#codex-user-input");
    await expect(approval).toContainText("cat /etc/os-release");
    await expect(approval.getByRole("radio", { name: /Allow remote operation/ })).toBeVisible();
    await chat.screenshot({ path: path.join(docsDirectory, "screenshot-approval-gate.png") });
  });
});
