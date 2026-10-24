import { describe, expect, it } from "@effect/vitest";

import {
  claudeProjectDirHint,
  claudeSessionIdsFromProviderThreads,
  orderProjectDirs,
} from "./threadUsageSources.ts";

describe("claudeSessionIdsFromProviderThreads", () => {
  const thread = (driver: string, nativeId: string | null) => ({
    driver,
    nativeThreadRef: nativeId === null ? null : { nativeId },
  });

  it("reads each Claude provider thread's session once", () => {
    expect(
      claudeSessionIdsFromProviderThreads(
        [
          thread("claudeAgent", "f49811c9-3f6f-4639-89cd-bda6acb6b650"),
          thread("codex", "codex-thread"),
          thread("claudeAgent", "bbbb"),
          thread("claudeAgent", "bbbb"),
          thread("claudeAgent", null),
        ],
        "claudeAgent",
      ),
    ).toEqual(["f49811c9-3f6f-4639-89cd-bda6acb6b650", "bbbb"]);
  });

  it("rejects ids that would escape the projects directory", () => {
    expect(
      claudeSessionIdsFromProviderThreads(
        [
          thread("claudeAgent", "../../etc/passwd"),
          thread("claudeAgent", "nested\\id"),
          thread("claudeAgent", ".."),
        ],
        "claudeAgent",
      ),
    ).toEqual([]);
  });
});

describe("orderProjectDirs", () => {
  it("puts the thread's own workspace first", () => {
    const dirs = ["-home-other", "-srv-projects-app", "-tmp-scratch"];

    expect(orderProjectDirs(dirs, "/srv/projects/app")).toEqual([
      "-srv-projects-app",
      "-home-other",
      "-tmp-scratch",
    ]);
  });

  it("also prefers worktree and named-agent directories derived from that workspace", () => {
    const dirs = ["-home-other", "-srv-projects-app--writer-1234", "-srv-projects-app"];

    expect(orderProjectDirs(dirs, "/srv/projects/app").slice(0, 2).sort()).toEqual([
      "-srv-projects-app",
      "-srv-projects-app--writer-1234",
    ]);
  });

  it("keeps the original order when the workspace is unknown", () => {
    const dirs = ["b", "a", "c"];

    expect(orderProjectDirs(dirs, null)).toEqual(dirs);
  });

  it("loses no directory when the hint matches nothing", () => {
    const dirs = ["a", "b", "c"];

    expect([...orderProjectDirs(dirs, "/nowhere")].sort()).toEqual(dirs);
  });
});

describe("claudeProjectDirHint", () => {
  it("replaces separators and dots the way Claude names project directories", () => {
    expect(claudeProjectDirHint("/srv/projects/tomo-sem")).toBe("-srv-projects-tomo-sem");
    expect(claudeProjectDirHint("/home/tomo/.t3/worktrees/x")).toBe("-home-tomo--t3-worktrees-x");
  });
});
