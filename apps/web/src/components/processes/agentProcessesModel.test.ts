import { EnvironmentId, ProjectId, ThreadId, type AgentProcess } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import type {
  EnvironmentProject,
  EnvironmentThreadShell,
} from "@t3tools/client-runtime/state/models";
import {
  collectListeningPorts,
  formatPortSummary,
  formatUptime,
  groupAgentProcesses,
  pathBasename,
  shortenCommand,
  type AgentProcessEntry,
} from "./agentProcessesModel";

const environmentId = EnvironmentId.make("environment-1");

function makeProcess(
  overrides: Partial<AgentProcess> & { readonly rootPid: number },
): AgentProcess {
  return {
    pgid: overrides.rootPid,
    threadId: null,
    providerSessionId: null,
    command: "pnpm dev",
    cwd: "/home/dev/app",
    startedAt: "2026-09-16T09:00:00.000Z",
    uptimeMs: 60_000,
    orphaned: false,
    listeningPorts: [],
    pids: [overrides.rootPid],
    ...overrides,
  };
}

function makeEntry(
  process: AgentProcess,
  thread?: { readonly id: ThreadId; readonly title: string; readonly projectId: ProjectId },
  project?: { readonly id: ProjectId; readonly title: string },
): AgentProcessEntry {
  return {
    environmentId,
    process,
    thread: thread === undefined ? null : ({ ...thread, environmentId } as EnvironmentThreadShell),
    project: project === undefined ? null : ({ ...project, environmentId } as EnvironmentProject),
  };
}

describe("formatUptime", () => {
  it("keeps seconds below a minute so a fresh process does not read as forgotten", () => {
    expect(formatUptime(0)).toBe("0s");
    expect(formatUptime(45_000)).toBe("45s");
  });

  it("drops to whole minutes, then hours and minutes", () => {
    expect(formatUptime(5 * 60_000)).toBe("5m");
    expect(formatUptime(2 * 3_600_000 + 14 * 60_000)).toBe("2h 14m");
    expect(formatUptime(3 * 3_600_000)).toBe("3h");
  });

  it("uses days once a process has been up longer than one", () => {
    expect(formatUptime(26 * 3_600_000)).toBe("1d 2h");
    expect(formatUptime(48 * 3_600_000)).toBe("2d");
  });
});

describe("shortenCommand", () => {
  it("strips a shell wrapper and its quotes", () => {
    expect(shortenCommand('sh -c "pnpm dev"')).toBe("pnpm dev");
    expect(shortenCommand("/bin/sh -c 'pnpm dev'")).toBe("pnpm dev");
    expect(shortenCommand("bash -lc pnpm dev")).toBe("pnpm dev");
  });

  it("peels nested wrappers", () => {
    expect(shortenCommand(`sh -c "bash -lc 'next dev'"`)).toBe("next dev");
  });

  it("collapses absolute interpreter and bin paths to their basename", () => {
    expect(
      shortenCommand(
        "/home/dev/.nvm/versions/node/v24/bin/node /home/dev/app/node_modules/.bin/next dev",
      ),
    ).toBe("node next dev");
  });

  it("leaves ordinary arguments alone", () => {
    expect(shortenCommand("pnpm dev --filter /home/dev/app")).toBe(
      "pnpm dev --filter /home/dev/app",
    );
  });

  it("collapses runs of whitespace", () => {
    expect(shortenCommand("  pnpm   dev  ")).toBe("pnpm dev");
  });
});

describe("pathBasename", () => {
  it("returns the trailing segment and tolerates trailing separators", () => {
    expect(pathBasename("/home/dev/app")).toBe("app");
    expect(pathBasename("/home/dev/app/")).toBe("app");
    expect(pathBasename("/")).toBe("/");
    expect(pathBasename("app")).toBe("app");
  });
});

describe("groupAgentProcesses", () => {
  const projectA = { id: ProjectId.make("project-a"), title: "App" };
  const threadOne = {
    id: ThreadId.make("thread-1"),
    title: "Ship the dashboard",
    projectId: projectA.id,
  };

  it("groups by project then thread and names what it cannot resolve", () => {
    const groups = groupAgentProcesses([
      makeEntry(
        makeProcess({ rootPid: 10, threadId: threadOne.id, command: "pnpm dev" }),
        threadOne,
        projectA,
      ),
      makeEntry(makeProcess({ rootPid: 11, providerSessionId: "session-abc" })),
    ]);

    expect(groups).toHaveLength(2);
    const [named, unknown] = groups;
    expect(named?.title).toBe("App");
    expect(named?.threads[0]?.title).toBe("Ship the dashboard");
    expect(named?.threads[0]?.providerSessionId).toBe(null);
    expect(unknown?.title).toBe("Unknown project");
    expect(unknown?.threads[0]?.title).toBe("Earlier session");
    expect(unknown?.threads[0]?.providerSessionId).toBe("session-abc");
  });

  it("falls back to a placeholder title when the thread is gone from the shell", () => {
    const groups = groupAgentProcesses([
      makeEntry(makeProcess({ rootPid: 12, threadId: ThreadId.make("thread-missing") })),
    ]);
    expect(groups[0]?.threads[0]?.title).toBe("Untitled thread");
  });

  it("keeps two leftover sessions apart", () => {
    const groups = groupAgentProcesses([
      makeEntry(makeProcess({ rootPid: 20, providerSessionId: "session-a" })),
      makeEntry(makeProcess({ rootPid: 21, providerSessionId: "session-b" })),
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0]?.threads).toHaveLength(2);
  });

  it("puts ended sessions first, then the longest running", () => {
    const groups = groupAgentProcesses([
      makeEntry(
        makeProcess({
          rootPid: 30,
          threadId: threadOne.id,
          startedAt: "2026-09-16T12:00:00.000Z",
        }),
        threadOne,
        projectA,
      ),
      makeEntry(
        makeProcess({
          rootPid: 31,
          threadId: threadOne.id,
          startedAt: "2026-09-16T08:00:00.000Z",
        }),
        threadOne,
        projectA,
      ),
      makeEntry(
        makeProcess({
          rootPid: 32,
          threadId: threadOne.id,
          orphaned: true,
          startedAt: "2026-09-16T13:00:00.000Z",
        }),
        threadOne,
        projectA,
      ),
    ]);

    expect(groups[0]?.threads[0]?.entries.map((entry) => entry.process.rootPid)).toEqual([
      32, 31, 30,
    ]);
  });

  it("orders projects by their most urgent row", () => {
    const projectB = { id: ProjectId.make("project-b"), title: "Docs" };
    const threadTwo = {
      id: ThreadId.make("thread-2"),
      title: "Rewrite the guide",
      projectId: projectB.id,
    };
    const groups = groupAgentProcesses([
      makeEntry(makeProcess({ rootPid: 40, threadId: threadOne.id }), threadOne, projectA),
      makeEntry(
        makeProcess({ rootPid: 41, threadId: threadTwo.id, orphaned: true }),
        threadTwo,
        projectB,
      ),
    ]);

    expect(groups.map((group) => group.title)).toEqual(["Docs", "App"]);
  });
});

describe("ports", () => {
  it("merges every chain's listening ports, ascending and deduplicated", () => {
    expect(
      collectListeningPorts([
        makeProcess({ rootPid: 50, listeningPorts: [5173, 3300] }),
        makeProcess({ rootPid: 51, listeningPorts: [3300] }),
      ]),
    ).toEqual([3300, 5173]);
  });

  it("caps the summary so a banner stays on one line", () => {
    expect(formatPortSummary([])).toBe(null);
    expect(formatPortSummary([3300])).toBe("localhost:3300");
    expect(formatPortSummary([1, 2, 3, 4])).toBe("localhost:1 · localhost:2 · localhost:3 +1");
  });
});
