import {
  ProjectId,
  type LinearIssueDetail,
  type PullRequestSummary,
  type VcsStatusResult,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import {
  GitMergeIcon,
  GitPullRequestClosedIcon,
  GitPullRequestDraftIcon,
  GitPullRequestIcon,
} from "lucide-react";

import {
  ChangeRequestStatusIcon,
  issueStatusIndicator,
  prStatusIndicator,
  settledPrHoverColorClass,
} from "./ThreadStatusIndicators";
import { newestPullRequestSummary } from "../state/pullRequests";

describe("ChangeRequestStatusIcon", () => {
  it.each([
    ["open", "open", false, GitPullRequestIcon],
    ["draft", "open", true, GitPullRequestDraftIcon],
    ["closed", "closed", false, GitPullRequestClosedIcon],
    ["merged", "merged", false, GitMergeIcon],
  ] as const)("uses the %s pull request glyph", (_label, state, isDraft, expectedIcon) => {
    expect(ChangeRequestStatusIcon({ state, isDraft }).type).toBe(expectedIcon);
  });
});

function status(overrides: Partial<VcsStatusResult> = {}): VcsStatusResult {
  return {
    isRepo: true,
    hasPrimaryRemote: true,
    isDefaultRef: false,
    refName: "feature/current",
    hasWorkingTreeChanges: false,
    workingTree: { files: [], insertions: 0, deletions: 0 },
    hasUpstream: true,
    aheadCount: 0,
    behindCount: 0,
    pr: {
      number: 42,
      title: "PR branch",
      url: "https://github.com/pingdotgg/t3code/pull/42",
      baseRef: "main",
      headRef: "feature/current",
      state: "open",
    },
    ...overrides,
  };
}

function pullRequestSummary(
  state: PullRequestSummary["state"],
  updatedAt: string,
): PullRequestSummary {
  return {
    provider: "github",
    projectId: ProjectId.make("project-1"),
    repository: "pingdotgg/t3code",
    number: 42,
    title: "Feature PR",
    url: "https://github.com/pingdotgg/t3code/pull/42",
    state,
    headBranch: "feature/current",
    baseBranch: "main",
    updatedAt,
  };
}

describe("shared pull request state", () => {
  it("shows a panel-observed merge instead of an older sidebar summary", () => {
    const open = pullRequestSummary("open", "2026-09-03T01:00:00.000Z");
    const merged = pullRequestSummary("merged", "2026-09-03T01:01:00.000Z");

    expect(newestPullRequestSummary(open, merged)).toBe(merged);
  });

  it("never lets a stale open response regress a merged observation", () => {
    const merged = pullRequestSummary("merged", "2026-09-03T01:01:00.000Z");
    const staleOpen = pullRequestSummary("open", "2026-09-03T01:00:00.000Z");

    expect(newestPullRequestSummary(merged, staleOpen)).toBe(merged);
  });

  it("accepts a newer open state after a closed pull request is reopened", () => {
    const closed = pullRequestSummary("closed", "2026-09-03T01:00:00.000Z");
    const reopened = pullRequestSummary("open", "2026-09-03T01:01:00.000Z");

    expect(newestPullRequestSummary(closed, reopened)).toBe(reopened);
  });
});

describe("prStatusIndicator", () => {
  it("formats PR tooltips with number, uppercase status, and title", () => {
    expect(prStatusIndicator(status().pr, undefined)).toMatchObject({
      tooltip: "PR #42 - Open: PR branch",
      tooltipLead: "PR #42 - Open",
      tooltipTitle: "PR branch",
    });
  });

  it("uses red for closed pull requests", () => {
    const closedPr = status().pr;
    if (!closedPr) throw new Error("Expected pull request fixture");

    expect(prStatusIndicator({ ...closedPr, state: "closed" }, undefined)?.colorClass).toContain(
      "text-red-600",
    );
  });

  it("uses gray and draft wording for draft pull requests", () => {
    const draftPr = status().pr;
    if (!draftPr) throw new Error("Expected pull request fixture");

    expect(prStatusIndicator({ ...draftPr, isDraft: true }, undefined)).toMatchObject({
      label: "PR draft",
      colorClass: "text-zinc-500 dark:text-zinc-400/80",
      tooltipLead: "PR #42 - Draft",
    });
  });
});

describe("settledPrHoverColorClass", () => {
  it.each([
    ["open", "text-emerald-600"],
    ["merged", "text-violet-600"],
    ["closed", "text-red-600"],
  ] as const)("restores the %s pull request color on row hover", (state, colorClass) => {
    expect(settledPrHoverColorClass(state)).toContain(`group-hover/v2-row:${colorClass}`);
  });

  it("keeps draft pull requests gray on row hover", () => {
    expect(settledPrHoverColorClass("open", true)).toContain("group-hover/v2-row:text-zinc-500");
  });
});

function linearIssue(overrides: Partial<LinearIssueDetail> = {}): LinearIssueDetail {
  return {
    id: "issue-uuid",
    identifier: "DEL-123",
    title: "Fix the login page",
    url: "https://linear.app/tomo/issue/DEL-123/fix-the-login-page",
    branchName: "tomo/del-123-fix-the-login-page",
    priority: 2,
    state: { id: "s1", name: "In Progress", type: "started", color: "#f2c94c", position: 1 },
    team: { id: "t1", key: "DEL", name: "Delivery" },
    assignee: null,
    updatedAt: "2026-09-07T10:00:00.000Z",
    description: null,
    comments: [],
    parent: null,
    children: [],
    labels: [],
    project: null,
    cycle: null,
    ...overrides,
  };
}

describe("issueStatusIndicator", () => {
  it("labels the chip with the identifier and carries Linear's own state color", () => {
    expect(issueStatusIndicator(linearIssue())).toEqual({
      label: "DEL-123",
      color: "#f2c94c",
      tooltip: "DEL-123 · Fix the login page · In Progress",
      url: "https://linear.app/tomo/issue/DEL-123/fix-the-login-page",
    });
  });

  it("has nothing to show without an issue", () => {
    expect(issueStatusIndicator(null)).toBeNull();
    expect(issueStatusIndicator(undefined)).toBeNull();
  });
});
