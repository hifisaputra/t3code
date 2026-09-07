import { describe, expect, it } from "vite-plus/test";

import { linearBranchPrefixOptions, linearBranchProblem } from "./linearIssueThreadDialog.logic";

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
