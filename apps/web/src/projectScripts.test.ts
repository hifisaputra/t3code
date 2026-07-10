import { describe, expect, it } from "vite-plus/test";
import {
  projectScriptCwd,
  projectScriptRuntimeEnv,
  resolveProjectScriptCwd,
  setupProjectScript,
} from "@t3tools/shared/projectScripts";

import {
  commandForProjectScript,
  detectScriptRunner,
  nextProjectScriptId,
  parsePackageScripts,
  parseWorkspacePackageScripts,
  primaryProjectScript,
  projectScriptIdFromCommand,
  workspaceGlobsFromPackageJson,
  workspaceGlobsFromPnpmWorkspaceYaml,
} from "./projectScripts";

describe("projectScripts helpers", () => {
  it("builds and parses script run commands", () => {
    const command = commandForProjectScript("lint");
    expect(command).toBe("script.lint.run");
    expect(projectScriptIdFromCommand(command)).toBe("lint");
    expect(projectScriptIdFromCommand("terminal.toggle")).toBeNull();
  });

  it("slugifies and dedupes project script ids", () => {
    expect(nextProjectScriptId("Run Tests", [])).toBe("run-tests");
    expect(nextProjectScriptId("Run Tests", ["run-tests"])).toBe("run-tests-2");
    expect(nextProjectScriptId("!!!", [])).toBe("script");
  });

  it("resolves primary and setup scripts", () => {
    const scripts = [
      {
        id: "setup",
        name: "Setup",
        command: "bun install",
        icon: "configure" as const,
        runOnWorktreeCreate: true,
      },
      {
        id: "test",
        name: "Test",
        command: "bun test",
        icon: "test" as const,
        runOnWorktreeCreate: false,
      },
    ];

    expect(primaryProjectScript(scripts)?.id).toBe("test");
    expect(setupProjectScript(scripts)?.id).toBe("setup");
  });

  it("builds default runtime env for scripts", () => {
    const env = projectScriptRuntimeEnv({
      project: { cwd: "/repo" },
      worktreePath: "/repo/worktree-a",
    });

    expect(env).toMatchObject({
      T3CODE_PROJECT_ROOT: "/repo",
      T3CODE_WORKTREE_PATH: "/repo/worktree-a",
    });
  });

  it("allows overriding runtime env values", () => {
    const env = projectScriptRuntimeEnv({
      project: { cwd: "/repo" },
      extraEnv: {
        T3CODE_PROJECT_ROOT: "/custom-root",
        CUSTOM_FLAG: "1",
      },
    });

    expect(env.T3CODE_PROJECT_ROOT).toBe("/custom-root");
    expect(env.CUSTOM_FLAG).toBe("1");
    expect(env.T3CODE_WORKTREE_PATH).toBeUndefined();
  });

  it("prefers the worktree path for script cwd resolution", () => {
    expect(
      projectScriptCwd({
        project: { cwd: "/repo" },
        worktreePath: "/repo/worktree-a",
      }),
    ).toBe("/repo/worktree-a");
    expect(
      projectScriptCwd({
        project: { cwd: "/repo" },
        worktreePath: null,
      }),
    ).toBe("/repo");
  });
});

describe("parsePackageScripts", () => {
  it("parses scripts into runnable suggestions with guessed icons", () => {
    const suggestions = parsePackageScripts(
      JSON.stringify({
        scripts: { test: "vitest", lint: "eslint .", build: "tsc", dev: "vite" },
      }),
    );

    expect(suggestions).toEqual([
      { name: "test", script: "vitest", command: "npm run test", icon: "test" },
      { name: "lint", script: "eslint .", command: "npm run lint", icon: "lint" },
      { name: "build", script: "tsc", command: "npm run build", icon: "build" },
      { name: "dev", script: "vite", command: "npm run dev", icon: "play" },
    ]);
  });

  it("derives the runner from the packageManager field", () => {
    const suggestions = parsePackageScripts(
      JSON.stringify({ packageManager: "pnpm@9.1.0", scripts: { build: "tsc" } }),
    );
    expect(suggestions[0]?.command).toBe("pnpm run build");

    const bun = parsePackageScripts(
      JSON.stringify({ packageManager: "bun@1.1.0", scripts: { build: "tsc" } }),
    );
    expect(bun[0]?.command).toBe("bun run build");
  });

  it("ignores non-string scripts, missing scripts, and invalid json", () => {
    expect(parsePackageScripts("not json")).toEqual([]);
    expect(parsePackageScripts(JSON.stringify({ name: "pkg" }))).toEqual([]);
    expect(
      parsePackageScripts(JSON.stringify({ scripts: { good: "tsc", bad: { nested: true } } })),
    ).toEqual([{ name: "good", script: "tsc", command: "npm run good", icon: "configure" }]);
  });
});

describe("workspace script discovery", () => {
  it("reads workspace globs from package.json (array and object forms)", () => {
    expect(
      workspaceGlobsFromPackageJson(JSON.stringify({ workspaces: ["packages/*", "apps/*"] })),
    ).toEqual(["packages/*", "apps/*"]);
    expect(
      workspaceGlobsFromPackageJson(
        JSON.stringify({ workspaces: { packages: ["libs/*"], nohoist: ["x"] } }),
      ),
    ).toEqual(["libs/*"]);
    expect(workspaceGlobsFromPackageJson(JSON.stringify({ name: "pkg" }))).toEqual([]);
  });

  it("reads workspace globs from pnpm-workspace.yaml (list and inline forms)", () => {
    expect(
      workspaceGlobsFromPnpmWorkspaceYaml(
        [
          "packages:",
          "  - 'packages/*'",
          '  - "apps/*"',
          "  - tools/cli",
          "catalog:",
          "  foo: 1",
        ].join("\n"),
      ),
    ).toEqual(["packages/*", "apps/*", "tools/cli"]);
    expect(workspaceGlobsFromPnpmWorkspaceYaml('packages: ["packages/*", "apps/*"]')).toEqual([
      "packages/*",
      "apps/*",
    ]);
  });

  it("detects the runner used for workspace commands", () => {
    expect(detectScriptRunner(JSON.stringify({ packageManager: "pnpm@9.0.0" }))).toBe("pnpm");
    expect(detectScriptRunner(JSON.stringify({}))).toBe("npm");
    expect(detectScriptRunner("not json")).toBe("npm");
  });

  it("builds workspace suggestions scoped to the package directory", () => {
    expect(
      parseWorkspacePackageScripts(
        JSON.stringify({ name: "@scope/web", scripts: { build: "vite build", dev: "vite" } }),
        "apps/web",
        "pnpm",
      ),
    ).toEqual([
      {
        name: "@scope/web:build",
        script: "vite build",
        command: "pnpm run build",
        cwd: "apps/web",
        icon: "build",
        workspace: "@scope/web",
      },
      {
        name: "@scope/web:dev",
        script: "vite",
        command: "pnpm run dev",
        cwd: "apps/web",
        icon: "play",
        workspace: "@scope/web",
      },
    ]);
  });

  it("resolves a script working directory against the base directory", () => {
    expect(resolveProjectScriptCwd("/repo", undefined)).toBe("/repo");
    expect(resolveProjectScriptCwd("/repo", "  ")).toBe("/repo");
    expect(resolveProjectScriptCwd("/repo", "apps/web")).toBe("/repo/apps/web");
    expect(resolveProjectScriptCwd("/repo/", "./apps/web")).toBe("/repo/apps/web");
    expect(resolveProjectScriptCwd("/repo/worktree-a", "packages/core")).toBe(
      "/repo/worktree-a/packages/core",
    );
    expect(resolveProjectScriptCwd("/repo", "/abs/path")).toBe("/abs/path");
    expect(resolveProjectScriptCwd("C:\\repo", "apps\\web")).toBe("C:\\repo\\apps\\web");
  });

  it("falls back to the directory name when the package has no name", () => {
    const [suggestion] = parseWorkspacePackageScripts(
      JSON.stringify({ scripts: { test: "vitest" } }),
      "packages/core",
      "npm",
    );
    expect(suggestion).toEqual({
      name: "core:test",
      script: "vitest",
      command: "npm run test",
      cwd: "packages/core",
      icon: "test",
      workspace: "core",
    });
  });
});
