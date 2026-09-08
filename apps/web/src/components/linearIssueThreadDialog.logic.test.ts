import { describe, expect, it } from "vite-plus/test";

import {
  filterLinearIssues,
  linearBranchPrefixOptions,
  linearBranchProblem,
  linearIssueThreadLaunchSummary,
  linearIssueThreadMessage,
  linearIssueThreadTitle,
} from "./linearIssueThreadDialog.logic";

describe("linearBranchPrefixOptions", () => {
  it("keeps the configured order", () => {
    expect(linearBranchPrefixOptions(["feat", "fix", "bug", "chore"])).toEqual([
      "feat",
      "fix",
      "bug",
      "chore",
    ]);
  });

  it("collapses spellings of the same namespace and drops empties", () => {
    expect(linearBranchPrefixOptions([" Feat ", "feat/", "/fix", "", "   "])).toEqual([
      "feat",
      "fix",
    ]);
  });

  it("appends a prefix the list does not offer, so the select has its own value", () => {
    expect(linearBranchPrefixOptions(["feat", "fix"], "hotfix")).toEqual(["feat", "fix", "hotfix"]);
  });

  it("does not repeat a prefix the list already offers", () => {
    expect(linearBranchPrefixOptions(["feat", "fix"], "Fix/")).toEqual(["feat", "fix"]);
  });

  it("has nothing to offer when nothing is configured", () => {
    expect(linearBranchPrefixOptions([])).toEqual([]);
    expect(linearBranchPrefixOptions([], null)).toEqual([]);
  });
});

describe("linearBranchProblem", () => {
  it("accepts any branch carrying the identifier, whatever its case", () => {
    expect(linearBranchProblem("feat/del-177-nightly", "DEL-177")).toBeNull();
    expect(linearBranchProblem("feat/DEL-177", "DEL-177")).toBeNull();
    expect(linearBranchProblem("  fix/del-177  ", "DEL-177")).toBeNull();
  });

  it("names the identifier the branch has to keep", () => {
    expect(linearBranchProblem("feat/nightly-checks", "DEL-177")).toBe(
      "Must include DEL-177 so Linear links the pull request.",
    );
  });

  it("treats an empty box as the same problem", () => {
    expect(linearBranchProblem("", "DEL-177")).toBe(
      "Must include DEL-177 so Linear links the pull request.",
    );
    expect(linearBranchProblem("   ", "DEL-177")).toBe(
      "Must include DEL-177 so Linear links the pull request.",
    );
  });
});

describe("filterLinearIssues", () => {
  const issues = [
    { identifier: "DEL-12", title: "Fix login redirect" },
    { identifier: "DEL-120", title: "Rename the settings page" },
    { identifier: "OPS-3", title: "Rotate the login secret" },
  ];

  it("shows everything for an empty box", () => {
    expect(filterLinearIssues(issues, "  ")).toBe(issues);
  });

  it("narrows by a word in the title, ignoring case", () => {
    expect(filterLinearIssues(issues, "LOGIN").map((issue) => issue.identifier)).toEqual([
      "DEL-12",
      "OPS-3",
    ]);
  });

  it("narrows by a partial identifier", () => {
    expect(filterLinearIssues(issues, "del-12").map((issue) => issue.identifier)).toEqual([
      "DEL-12",
      "DEL-120",
    ]);
  });
});

describe("linearIssueThreadTitle", () => {
  it("leads with the identifier", () => {
    expect(linearIssueThreadTitle({ identifier: "DEL-12", title: "  Fix login  " })).toBe(
      "DEL-12 Fix login",
    );
  });

  it("cuts a long title to one line", () => {
    const title = linearIssueThreadTitle({ identifier: "DEL-12", title: "x".repeat(200) });
    expect(title.length).toBeLessThanOrEqual(81);
    expect(title.endsWith("…")).toBe(true);
  });
});

describe("linearIssueThreadMessage", () => {
  it("sends the kickoff alone without the caret room", () => {
    expect(linearIssueThreadMessage("Work on DEL-12\nhttps://x\n\n", "  ")).toBe(
      "Work on DEL-12\nhttps://x",
    );
  });

  it("puts the note under the kickoff", () => {
    expect(linearIssueThreadMessage("Work on DEL-12\n\n", " Keep the old route. ")).toBe(
      "Work on DEL-12\n\nKeep the old route.",
    );
  });
});

describe("linearIssueThreadLaunchSummary", () => {
  it("names the branch about to be cut", () => {
    expect(
      linearIssueThreadLaunchSummary({
        mode: "worktree",
        branchMode: "issue",
        issueBranch: "ada/del-123-fix-login",
        currentBranch: "main",
      }),
    ).toBe("New worktree on ada/del-123-fix-login");
  });

  it("names the branch it stays on instead", () => {
    expect(
      linearIssueThreadLaunchSummary({
        mode: "local",
        branchMode: "current",
        issueBranch: "ada/del-123-fix-login",
        currentBranch: "release/24.3",
      }),
    ).toBe("This checkout, staying on release/24.3");
  });

  it("says as much before the checkout's status arrives", () => {
    expect(
      linearIssueThreadLaunchSummary({
        mode: "local",
        branchMode: "current",
        issueBranch: "ada/del-123-fix-login",
        currentBranch: null,
      }),
    ).toBe("This checkout, on the branch it is already on");
  });
});
