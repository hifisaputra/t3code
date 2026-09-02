import { describe, expect, it } from "@effect/vitest";

import {
  claudeProjectDirHint,
  claudeSessionIdsFromResumeCursor,
  cwdFromRuntimePayload,
  orderProjectDirs,
} from "./threadUsageSources.ts";

describe("claudeSessionIdsFromResumeCursor", () => {
  it("reads the session a live thread writes to", () => {
    expect(
      claudeSessionIdsFromResumeCursor({
        threadId: "t",
        resume: "f49811c9-3f6f-4639-89cd-bda6acb6b650",
        turnCount: 2,
      }),
    ).toEqual(["f49811c9-3f6f-4639-89cd-bda6acb6b650"]);
  });

  it("keeps the resumed-from session so a continued thread is not undercounted", () => {
    expect(
      claudeSessionIdsFromResumeCursor({
        resume: "aaaa",
        resumeSessionAt: "bbbb",
      }),
    ).toEqual(["aaaa", "bbbb"]);
  });

  it("falls back to the older sessionId field", () => {
    expect(claudeSessionIdsFromResumeCursor({ sessionId: "cccc" })).toEqual(["cccc"]);
  });

  it("de-duplicates when the cursor repeats one id", () => {
    expect(
      claudeSessionIdsFromResumeCursor({
        resume: "aaaa",
        sessionId: "aaaa",
        resumeSessionAt: "aaaa",
      }),
    ).toEqual(["aaaa"]);
  });

  it("rejects ids that would escape the projects directory", () => {
    expect(
      claudeSessionIdsFromResumeCursor({
        resume: "../../etc/passwd",
        sessionId: "nested/id",
        resumeSessionAt: "..",
      }),
    ).toEqual([]);
  });

  it("returns nothing for a cursor that carries no session", () => {
    expect(claudeSessionIdsFromResumeCursor(null)).toEqual([]);
    expect(claudeSessionIdsFromResumeCursor(undefined)).toEqual([]);
    expect(claudeSessionIdsFromResumeCursor("resume")).toEqual([]);
    expect(claudeSessionIdsFromResumeCursor([])).toEqual([]);
    expect(claudeSessionIdsFromResumeCursor({ turnCount: 3 })).toEqual([]);
  });
});

describe("cwdFromRuntimePayload", () => {
  it("reads the workspace path", () => {
    expect(cwdFromRuntimePayload({ cwd: "/srv/projects/app", model: "m" })).toBe(
      "/srv/projects/app",
    );
  });

  it("returns null when there is no usable path", () => {
    expect(cwdFromRuntimePayload({ cwd: "" })).toBeNull();
    expect(cwdFromRuntimePayload({})).toBeNull();
    expect(cwdFromRuntimePayload(null)).toBeNull();
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
