import type { LinearIssueDetail, ServerProvider } from "@t3tools/contracts";
import { ProviderDriverKind, ProviderInstanceId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  formatLinearIssueForComposer,
  formatLinearIssueKickoff,
  hasLinearWorkSkill,
} from "./linearIssueComposerSeed";

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

function provider(overrides: Partial<ServerProvider> = {}): ServerProvider {
  return {
    instanceId: ProviderInstanceId.make("claude"),
    driver: ProviderDriverKind.make("claude"),
    enabled: true,
    installed: true,
    version: null,
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: "2026-09-07T10:00:00.000Z",
    models: [],
    slashCommands: [],
    skills: [],
    ...overrides,
  };
}

function skill(overrides: Partial<ServerProvider["skills"][number]> = {}) {
  return {
    name: "linear-work",
    path: "/home/dev/.claude/skills/linear-work/SKILL.md",
    enabled: true,
    ...overrides,
  };
}

describe("hasLinearWorkSkill", () => {
  it("finds the skill on any provider", () => {
    expect(hasLinearWorkSkill([provider(), provider({ skills: [skill()] })])).toBe(true);
  });

  it("is false when no provider knows it", () => {
    expect(hasLinearWorkSkill([])).toBe(false);
    expect(hasLinearWorkSkill([provider({ skills: [skill({ name: "linear-task" })] })])).toBe(
      false,
    );
  });

  it("ignores a skill the mention could not start", () => {
    expect(hasLinearWorkSkill([provider({ skills: [skill({ enabled: false })] })])).toBe(false);
    expect(hasLinearWorkSkill([provider({ skills: [skill({ userInvocable: false })] })])).toBe(
      false,
    );
  });

  it("prefers the workspace snapshot for the checkout the thread runs in", () => {
    const providers = [
      provider({
        skills: [],
        workspaceSnapshots: [
          {
            cwd: "/repos/app",
            checkedAt: "2026-09-07T10:00:00.000Z",
            slashCommands: [],
            skills: [skill()],
          },
        ],
      }),
    ];
    expect(hasLinearWorkSkill(providers, "/repos/app")).toBe(true);
    expect(hasLinearWorkSkill(providers, "/repos/other")).toBe(false);
  });
});

describe("formatLinearIssueKickoff", () => {
  it("leads with the skill mention so the issue becomes its arguments", () => {
    expect(formatLinearIssueKickoff(issue(), { agentTools: true, skill: true })).toBe(
      [
        "$linear-work DEL-123: Fix the login page",
        "https://linear.app/tomo/issue/DEL-123/fix-the-login-page",
        "",
        "",
      ].join("\n"),
    );
  });

  it("spells out the runbook when the skill is not installed", () => {
    expect(formatLinearIssueKickoff(issue(), { agentTools: true, skill: false })).toBe(
      [
        "Work on Linear issue DEL-123: Fix the login page",
        "https://linear.app/tomo/issue/DEL-123/fix-the-login-page",
        "",
        "Read the issue and its comments with the get_issue and list_comments tools before doing anything else. Restate what done looks like in one to three lines. If a product decision is missing or the brief is unclear, ask me and stop. Otherwise start.",
        "",
        "",
      ].join("\n"),
    );
  });

  it("quotes the ticket when the agent has no Linear tools", () => {
    expect(formatLinearIssueKickoff(issue(), { agentTools: false, skill: false })).toBe(
      [
        "Work on Linear issue DEL-123: Fix the login page",
        "https://linear.app/tomo/issue/DEL-123/fix-the-login-page",
        "",
        "The ticket is quoted below. Restate what done looks like in one to three lines. If a product decision is missing or the brief is unclear, ask me and stop. Otherwise start.",
        "",
        formatLinearIssueForComposer(issue()).trimEnd(),
        "",
        "",
      ].join("\n"),
    );
  });

  it("keeps the mention above the quoted ticket when both apply", () => {
    expect(formatLinearIssueKickoff(issue(), { agentTools: false, skill: true })).toBe(
      [
        "$linear-work DEL-123: Fix the login page",
        "https://linear.app/tomo/issue/DEL-123/fix-the-login-page",
        "",
        formatLinearIssueForComposer(issue()).trimEnd(),
        "",
        "",
      ].join("\n"),
    );
  });

  it("never quotes the ticket when the agent can read it itself", () => {
    for (const withSkill of [true, false]) {
      const seed = formatLinearIssueKickoff(issue(), { agentTools: true, skill: withSkill });
      expect(seed).not.toContain("linear-issue");
      expect(seed).not.toContain("The login button does nothing on Safari.");
    }
  });
});
