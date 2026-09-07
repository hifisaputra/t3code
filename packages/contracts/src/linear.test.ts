import { describe, expect, it } from "vite-plus/test";

import {
  linearBranchNamesIssue,
  linearIssueBranchName,
  resolveLinearRepositoryMapping,
} from "./linear.ts";

const teamRow = { teamKey: "DEL", linearProjectId: null, projectId: "repo-a" };
const projectRow = { teamKey: null, linearProjectId: "lp-1", projectId: "repo-b" };
const rows = [teamRow, projectRow];

describe("resolveLinearRepositoryMapping", () => {
  it("prefers the row naming the issue's project over the row naming its team", () => {
    const issue = { team: { key: "DEL" }, project: { id: "lp-1" } };
    expect(resolveLinearRepositoryMapping(rows, issue)).toBe(projectRow);
  });

  it("falls back to the team row when the issue's project has no row", () => {
    const issue = { team: { key: "del" }, project: { id: "lp-other" } };
    expect(resolveLinearRepositoryMapping(rows, issue)).toBe(teamRow);
  });

  it("matches team keys regardless of case and returns null when nothing matches", () => {
    expect(
      resolveLinearRepositoryMapping(rows, { team: { key: "ops" }, project: null }),
    ).toBeNull();
    expect(
      resolveLinearRepositoryMapping([{ ...teamRow, teamKey: "ops" }], {
        team: { key: "OPS" },
        project: null,
      }),
    ).toEqual({ ...teamRow, teamKey: "ops" });
  });
});

describe("linearIssueBranchName", () => {
  const issue = {
    identifier: "DEL-177",
    title: "Turn on the nightly collection of AI answers",
    branchName: "hifi/del-177-turn-on-the-nightly-collection-of-ai-answers",
    labels: [{ name: "Bug" }],
  };
  const naming = {
    style: "prefixed" as const,
    prefixes: ["feat", "fix", "chore"],
    labelPrefixes: [{ label: "bug", prefix: "fix" }],
  };

  it("keeps Linear's own branch under the linear style", () => {
    expect(linearIssueBranchName(issue, { ...naming, style: "linear" })).toBe(issue.branchName);
  });

  it("swaps the namespace for the label's prefix and keeps Linear's slug", () => {
    expect(linearIssueBranchName(issue, naming)).toBe(
      "fix/del-177-turn-on-the-nightly-collection-of-ai-answers",
    );
  });

  it("falls back to the first prefix when no label rule matches", () => {
    expect(linearIssueBranchName({ ...issue, labels: [] }, naming)).toBe(
      "feat/del-177-turn-on-the-nightly-collection-of-ai-answers",
    );
    expect(linearIssueBranchName({ ...issue, labels: [] }, { ...naming, prefixes: [] })).toBe(
      "feat/del-177-turn-on-the-nightly-collection-of-ai-answers",
    );
  });

  it("honours an explicit prefix, however it was typed", () => {
    expect(linearIssueBranchName(issue, naming, " Chore/ ")).toBe(
      "chore/del-177-turn-on-the-nightly-collection-of-ai-answers",
    );
  });

  it("rebuilds the slug from the title when Linear's branch lacks the identifier", () => {
    expect(
      linearIssueBranchName({ ...issue, branchName: "tomo/nightly", labels: [] }, naming),
    ).toBe("feat/del-177-turn-on-the-nightly-collection-of-ai-answers");
  });

  it("knows whether a branch still names the issue", () => {
    expect(linearBranchNamesIssue("feat/DEL-177-x", "del-177")).toBe(true);
    expect(linearBranchNamesIssue("feat/nightly", "DEL-177")).toBe(false);
  });
});
