import type { LinearIssueDetail } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { formatLinearIssueForComposer } from "./linearIssueComposerSeed";

function issue(overrides: Partial<LinearIssueDetail> = {}): LinearIssueDetail {
  return {
    id: "issue-uuid",
    identifier: "DEL-123",
    title: "Fix the login page",
    url: "https://linear.app/tomo/issue/DEL-123/fix-the-login-page",
    branchName: "tomo/del-123-fix-the-login-page",
    priority: 2,
    state: { id: "state-1", name: "In Progress", type: "started", color: "#f2c94c", position: 1 },
    team: { id: "team-1", key: "DEL", name: "Delivery" },
    assignee: { id: "user-1", name: "alice", displayName: "Alice" },
    updatedAt: "2026-09-07T10:00:00.000Z",
    description: "The login button does nothing on Safari.",
    comments: [],
    parent: null,
    children: [],
    labels: [],
    project: null,
    cycle: null,
    ...overrides,
  };
}

describe("formatLinearIssueForComposer", () => {
  it("opens with a linear-issue fence and closes it, leaving room below", () => {
    const seed = formatLinearIssueForComposer(issue());
    expect(seed.startsWith("```linear-issue\n")).toBe(true);
    expect(seed.endsWith("```\n\n")).toBe(true);
  });

  it("leads with the identifier, title, URL, and the state line", () => {
    const seed = formatLinearIssueForComposer(issue());
    const lines = seed.split("\n");
    expect(lines[1]).toBe("DEL-123: Fix the login page");
    expect(lines[2]).toBe("https://linear.app/tomo/issue/DEL-123/fix-the-login-page");
    expect(lines[3]).toBe("State: In Progress · Team: DEL · Assignee: Alice");
  });

  it("says unassigned when nobody owns the issue", () => {
    const seed = formatLinearIssueForComposer(issue({ assignee: null }));
    expect(seed).toContain("Assignee: unassigned");
  });

  it("keeps the description markdown as written", () => {
    const seed = formatLinearIssueForComposer(
      issue({ description: "## Steps\n\n1. Open Safari\n2. Click **Log in**" }),
    );
    expect(seed).toContain("## Steps\n\n1. Open Safari\n2. Click **Log in**");
  });

  it("omits the description block when the issue has none", () => {
    const seed = formatLinearIssueForComposer(issue({ description: null }));
    expect(seed).toBe(
      [
        "```linear-issue",
        "DEL-123: Fix the login page",
        "https://linear.app/tomo/issue/DEL-123/fix-the-login-page",
        "State: In Progress · Team: DEL · Assignee: Alice",
        "```",
        "",
        "",
      ].join("\n"),
    );
  });

  it("truncates a description that would dwarf the turn", () => {
    const seed = formatLinearIssueForComposer(issue({ description: "x".repeat(20_000) }));
    expect(seed).toContain("… truncated");
    expect(seed.length).toBeLessThan(7_000);
  });

  it("lists comments with author and day", () => {
    const seed = formatLinearIssueForComposer(
      issue({
        comments: [
          {
            id: "c1",
            body: "Reproduced on 17.4.",
            url: "https://linear.app/tomo/issue/DEL-123#comment-c1",
            createdAt: "2026-09-01T08:30:00.000Z",
            author: { id: "user-2", name: "bob", displayName: "Bob" },
          },
        ],
      }),
    );
    expect(seed).toContain("Comments\n- **Bob** (2026-09-01): Reproduced on 17.4.");
  });

  it("indents a multi-line comment so the list survives", () => {
    const seed = formatLinearIssueForComposer(
      issue({
        comments: [
          {
            id: "c1",
            body: "First line\nsecond line",
            url: "https://linear.app/tomo/issue/DEL-123#comment-c1",
            createdAt: "2026-09-01T08:30:00.000Z",
            author: null,
          },
        ],
      }),
    );
    expect(seed).toContain("- **Unknown** (2026-09-01): First line\n  second line");
  });

  it("truncates a long comment thread", () => {
    const seed = formatLinearIssueForComposer(
      issue({
        description: null,
        comments: Array.from({ length: 400 }, (_unused, index) => ({
          id: `c${index}`,
          body: "y".repeat(200),
          url: "https://linear.app/tomo/issue/DEL-123",
          createdAt: "2026-09-01T08:30:00.000Z",
          author: { id: "user-2", name: "bob", displayName: "Bob" },
        })),
      }),
    );
    expect(seed).toContain("… truncated");
    expect(seed.length).toBeLessThan(7_000);
  });

  it("widens the fence so a fenced description cannot close the block", () => {
    const seed = formatLinearIssueForComposer(issue({ description: "```ts\nconst a = 1;\n```" }));
    expect(seed.startsWith("````linear-issue\n")).toBe(true);
    expect(seed.endsWith("````\n\n")).toBe(true);
  });
});
