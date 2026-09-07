import type { EnvironmentId, LinearIssueSummary, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  collectIssueListFacets,
  linkedThreadsByIssueIdentifier,
  matchesIssueFilters,
  matchesIssueQuery,
  resolveIssuesEnvironmentId,
  sortIssues,
} from "./issueList.logic";

function issue(overrides: Partial<LinearIssueSummary> = {}): LinearIssueSummary {
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
    project: null,
    cycle: null,
    updatedAt: "2026-09-07T10:00:00.000Z",
    ...overrides,
  };
}

const environmentId = (value: string) => value as EnvironmentId;

describe("collectIssueListFacets", () => {
  it("names each team once, sorted by team name", () => {
    const facets = collectIssueListFacets([
      issue({ team: { id: "t2", key: "OPS", name: "Operations" } }),
      issue({ team: { id: "t1", key: "DEL", name: "Delivery" } }),
      issue({ team: { id: "t1", key: "DEL", name: "Delivery" } }),
    ]);
    expect(facets.teams).toEqual([
      { key: "DEL", name: "Delivery" },
      { key: "OPS", name: "Operations" },
    ]);
  });

  it("collects projects by id, sorted by name, skipping issues without one", () => {
    const facets = collectIssueListFacets([
      issue({ project: { id: "p2", name: "Radar", url: "https://linear.app/p2" } }),
      issue({ project: null }),
      issue({ project: { id: "p1", name: "Beacon", url: "https://linear.app/p1" } }),
    ]);
    expect(facets.projects).toEqual([
      { id: "p1", name: "Beacon" },
      { id: "p2", name: "Radar" },
    ]);
  });

  it("labels cycles by number unless named, newest cycle first", () => {
    const facets = collectIssueListFacets([
      issue({ cycle: { id: "c11", number: 11, name: null } }),
      issue({ cycle: { id: "c13", number: 13, name: "Hardening" } }),
      issue({ cycle: { id: "c12", number: 12, name: "  " } }),
    ]);
    expect(facets.cycles).toEqual([
      { id: "c13", label: "Hardening" },
      { id: "c12", label: "Cycle 12" },
      { id: "c11", label: "Cycle 11" },
    ]);
  });
});

describe("matchesIssueFilters", () => {
  const withProjectAndCycle = issue({
    project: { id: "p1", name: "Beacon", url: "https://linear.app/p1" },
    cycle: { id: "c12", number: 12, name: null },
  });

  it("keeps everything when no filter is set", () => {
    expect(matchesIssueFilters(withProjectAndCycle, {})).toBe(true);
  });

  it("filters by team key, project id and cycle id", () => {
    expect(matchesIssueFilters(withProjectAndCycle, { team: "DEL" })).toBe(true);
    expect(matchesIssueFilters(withProjectAndCycle, { team: "OPS" })).toBe(false);
    expect(matchesIssueFilters(withProjectAndCycle, { project: "p1" })).toBe(true);
    expect(matchesIssueFilters(withProjectAndCycle, { project: "p2" })).toBe(false);
    expect(matchesIssueFilters(withProjectAndCycle, { cycle: "c12" })).toBe(true);
    expect(matchesIssueFilters(withProjectAndCycle, { cycle: "c11" })).toBe(false);
  });

  it("drops an issue with no project or cycle once one is asked for", () => {
    expect(matchesIssueFilters(issue(), { project: "p1" })).toBe(false);
    expect(matchesIssueFilters(issue(), { cycle: "c12" })).toBe(false);
  });
});

describe("matchesIssueQuery", () => {
  it("matches the identifier and the title, ignoring case", () => {
    expect(matchesIssueQuery(issue(), "del-1")).toBe(true);
    expect(matchesIssueQuery(issue(), "LOGIN")).toBe(true);
    expect(matchesIssueQuery(issue(), "checkout")).toBe(false);
  });

  it("keeps everything for an empty or blank query", () => {
    expect(matchesIssueQuery(issue(), "")).toBe(true);
    expect(matchesIssueQuery(issue(), "   ")).toBe(true);
  });
});

describe("sortIssues", () => {
  const started = (overrides: Partial<LinearIssueSummary> = {}) => issue(overrides);
  const unstarted = (overrides: Partial<LinearIssueSummary> = {}) =>
    issue({
      state: { id: "s2", name: "Todo", type: "unstarted", color: "#aaa", position: 2 },
      ...overrides,
    });
  const backlog = (overrides: Partial<LinearIssueSummary> = {}) =>
    issue({
      state: { id: "s3", name: "Backlog", type: "backlog", color: "#bbb", position: 3 },
      ...overrides,
    });

  it("puts started ahead of todo ahead of backlog", () => {
    const sorted = sortIssues([
      backlog({ identifier: "DEL-3" }),
      unstarted({ identifier: "DEL-2" }),
      started({ identifier: "DEL-1" }),
    ]);
    expect(sorted.map((entry) => entry.identifier)).toEqual(["DEL-1", "DEL-2", "DEL-3"]);
  });

  it("ranks urgent first and no-priority last inside a state", () => {
    const sorted = sortIssues([
      unstarted({ identifier: "none", priority: 0 }),
      unstarted({ identifier: "low", priority: 4 }),
      unstarted({ identifier: "urgent", priority: 1 }),
    ]);
    expect(sorted.map((entry) => entry.identifier)).toEqual(["urgent", "low", "none"]);
  });

  it("breaks a tie with the most recently updated issue", () => {
    const sorted = sortIssues([
      unstarted({ identifier: "older", updatedAt: "2026-09-01T00:00:00.000Z" }),
      unstarted({ identifier: "newer", updatedAt: "2026-09-06T00:00:00.000Z" }),
    ]);
    expect(sorted.map((entry) => entry.identifier)).toEqual(["newer", "older"]);
  });

  it("leaves the input array untouched", () => {
    const input = [unstarted({ identifier: "DEL-2" }), started({ identifier: "DEL-1" })];
    sortIssues(input);
    expect(input.map((entry) => entry.identifier)).toEqual(["DEL-2", "DEL-1"]);
  });
});

describe("linkedThreadsByIssueIdentifier", () => {
  const shell = (
    overrides: {
      id?: string;
      environmentId?: string;
      updatedAt?: string;
      archivedAt?: string | null;
      identifier?: string | null;
    } = {},
  ) => ({
    environmentId: environmentId(overrides.environmentId ?? "env-1"),
    id: (overrides.id ?? "thread-1") as ThreadId,
    updatedAt: overrides.updatedAt ?? "2026-09-01T00:00:00.000Z",
    archivedAt: overrides.archivedAt ?? null,
    linkedIssue:
      overrides.identifier === null ? null : { identifier: overrides.identifier ?? "DEL-123" },
  });

  it("takes the most recently updated thread for an identifier", () => {
    const linked = linkedThreadsByIssueIdentifier([
      shell({ id: "old", updatedAt: "2026-09-01T00:00:00.000Z" }),
      shell({ id: "new", updatedAt: "2026-09-05T00:00:00.000Z" }),
      shell({ id: "older", updatedAt: "2026-08-01T00:00:00.000Z" }),
    ]);
    expect(linked.get("DEL-123")).toEqual({ environmentId: "env-1", threadId: "new" });
  });

  it("ignores archived threads even when they moved last", () => {
    const linked = linkedThreadsByIssueIdentifier([
      shell({ id: "live", updatedAt: "2026-09-01T00:00:00.000Z" }),
      shell({
        id: "archived",
        updatedAt: "2026-09-05T00:00:00.000Z",
        archivedAt: "2026-09-06T00:00:00.000Z",
      }),
    ]);
    expect(linked.get("DEL-123")?.threadId).toBe("live");
  });

  it("offers nothing for an issue whose only thread is archived", () => {
    const linked = linkedThreadsByIssueIdentifier([
      shell({ id: "archived", archivedAt: "2026-09-06T00:00:00.000Z" }),
    ]);
    expect(linked.has("DEL-123")).toBe(false);
  });

  it("skips threads with no linked issue and keeps identifiers apart", () => {
    const linked = linkedThreadsByIssueIdentifier([
      shell({ id: "unlinked", identifier: null }),
      shell({ id: "ops", identifier: "OPS-7", environmentId: "env-2" }),
    ]);
    expect(linked.size).toBe(1);
    expect(linked.get("OPS-7")).toEqual({ environmentId: "env-2", threadId: "ops" });
  });
});

describe("resolveIssuesEnvironmentId", () => {
  const candidate = (id: string, apiKey: string) => ({
    environmentId: environmentId(id),
    serverConfig: { settings: { linear: { apiKey } } },
  });

  it("prefers the asked-for environment when it holds a key", () => {
    const resolved = resolveIssuesEnvironmentId({
      environments: [candidate("a", "redacted"), candidate("b", "redacted")],
      preferred: environmentId("b"),
    });
    expect(resolved).toBe("b");
  });

  it("falls back to the first connected environment with a key", () => {
    const resolved = resolveIssuesEnvironmentId({
      environments: [candidate("a", ""), candidate("b", "redacted"), candidate("c", "redacted")],
      preferred: environmentId("a"),
    });
    expect(resolved).toBe("b");
  });

  it("returns null when no environment has a key", () => {
    expect(
      resolveIssuesEnvironmentId({
        environments: [candidate("a", ""), { environmentId: environmentId("b") }],
      }),
    ).toBe(null);
  });
});
