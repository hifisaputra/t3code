import { describe, expect, it } from "@effect/vitest";
import { AGENT_PROCESS_THREAD_ENV } from "@t3tools/shared/agentProcessMarker";

import {
  agentProcessStartedAt,
  attributeAgentProcess,
  buildAgentProcesses,
  parseEnviron,
  parsePsEnvironmentDump,
  parseLsofListeners,
  parsePsTable,
  parseSsListeners,
  selectStopTarget,
  type ProcessTableRow,
} from "./agentProcessModel.ts";

const NOW = Date.UTC(2026, 0, 1, 12, 0, 0);
const SERVER_PID = 100;

const row = (pid: number, ppid: number, args: string, etimeSeconds = 600): ProcessTableRow => ({
  pid,
  ppid,
  pgid: pid,
  etimeSeconds,
  args,
});

const marked = (threadId: string, extra: ReadonlyArray<string> = []): ReadonlyArray<string> => [
  "PATH=/usr/bin",
  `${AGENT_PROCESS_THREAD_ENV}=${threadId}`,
  "T3CODE_REMOTE_REACHABLE=1",
  ...extra,
];

const legacy: ReadonlyArray<string> = [
  "PATH=/usr/bin",
  "CLAUDECODE=1",
  "CLAUDE_CODE_ENTRYPOINT=sdk-ts",
  "CLAUDE_CODE_SESSION_ID=b8c107fe-1b2d-45a3-b50d-409f27f5cba1",
  "T3CODE_DISABLE_PREVIEW_MCP=1",
];

describe("parsePsTable", () => {
  it("keeps the whole command line and drops headers and blank lines", () => {
    const parsed = parsePsTable(
      [
        " 3616932     876 3616932   4210 node /home/tomo/.local/bin/pnpm dev",
        "    876       1     876 120000 /lib/systemd/systemd --user",
        "",
        "not a process row",
      ].join("\n"),
    );
    expect(parsed).toEqual([
      {
        pid: 3616932,
        ppid: 876,
        pgid: 3616932,
        etimeSeconds: 4210,
        args: "node /home/tomo/.local/bin/pnpm dev",
      },
      { pid: 876, ppid: 1, pgid: 876, etimeSeconds: 120000, args: "/lib/systemd/systemd --user" },
    ]);
  });
});

describe("parseEnviron", () => {
  it("splits NUL separated entries and drops the trailing empty one", () => {
    expect(parseEnviron(["PATH=/usr/bin", "T3CODE_THREAD_ID=thread-a", ""].join("\0"))).toEqual([
      "PATH=/usr/bin",
      "T3CODE_THREAD_ID=thread-a",
    ]);
  });
});

describe("parsePsEnvironmentDump", () => {
  it("collects whitespace separated tokens per pid, as macOS `ps -E` prints them", () => {
    const parsed = parsePsEnvironmentDump(" 412 node dev PATH=/usr/bin T3CODE_THREAD_ID=thread-a");
    expect(parsed.get(412)).toEqual(["node", "dev", "PATH=/usr/bin", "T3CODE_THREAD_ID=thread-a"]);
  });
});

describe("listening port parsers", () => {
  it("groups lsof addresses under the process that opened them", () => {
    const parsed = parseLsofListeners(
      ["p3617107", "cnext-server", "n*:3300", "n127.0.0.1:3301", "p982", "n127.0.0.1:20242"].join(
        "\n",
      ),
    );
    expect(parsed.get(3617107)).toEqual([3300, 3301]);
    expect(parsed.get(982)).toEqual([20242]);
  });

  it("reads every owner ss reports for a listening socket", () => {
    const parsed = parseSsListeners(
      [
        'LISTEN 0      511        *:3300    *:* users:(("next-server (v1",pid=3617107,fd=22))',
        "LISTEN 0      4096       0.0.0.0:22 0.0.0.0:*",
      ].join("\n"),
    );
    expect(parsed.get(3617107)).toEqual([3300]);
    expect(parsed.size).toBe(1);
  });
});

describe("attributeAgentProcess", () => {
  it("attributes a marked process to its thread", () => {
    expect(attributeAgentProcess([...marked("thread-a")])).toEqual({
      threadId: "thread-a",
      providerSessionId: null,
    });
  });

  it("reads the provider session id beside the marker", () => {
    expect(
      attributeAgentProcess([...marked("thread-a", ["CLAUDE_CODE_SESSION_ID=session-1"])]),
    ).toEqual({ threadId: "thread-a", providerSessionId: "session-1" });
  });

  it("recognises a pre-marker Claude session by its own variables", () => {
    expect(attributeAgentProcess([...legacy])).toEqual({
      threadId: null,
      providerSessionId: "b8c107fe-1b2d-45a3-b50d-409f27f5cba1",
    });
  });

  it("ignores an unrelated process and a Claude CLI started outside T3", () => {
    expect(attributeAgentProcess(["PATH=/usr/bin"])).toBeNull();
    expect(attributeAgentProcess(["CLAUDE_CODE_ENTRYPOINT=sdk-ts", "CLAUDECODE=1"])).toBeNull();
  });
});

describe("buildAgentProcesses", () => {
  const table: ReadonlyArray<ProcessTableRow> = [
    row(SERVER_PID, 1, "node t3 server"),
    // Claude CLI: a direct child of the server.
    row(200, SERVER_PID, "claude --print"),
    // A tool command of the running turn, too young to list.
    row(210, 200, "node build.js", 2),
    // Codex: a shell wrapper below the server, then the app-server itself.
    row(300, SERVER_PID, "sh -c codex app-server"),
    row(301, 300, "/usr/bin/codex app-server"),
    row(302, 301, "node /usr/bin/pnpm test:watch"),
    // A registered provider pid the tree alone would not identify.
    row(400, 399, "cursor-agent acp"),
    row(401, 400, "node vite"),
    // A leftover whose provider CLI is gone: init adopted it.
    row(500, 1, "node /home/tomo/.local/bin/pnpm dev", 4210),
    row(501, 500, "sh -c next dev", 4209),
    row(502, 501, "next-server", 4208),
    // Not agent-owned, so it ends the chain.
    row(503, 502, "docker-proxy"),
    row(399, 1, "systemd --user"),
  ];

  const envByPid = new Map<number, ReadonlyArray<string>>([
    [200, marked("thread-a")],
    [210, marked("thread-a")],
    [300, marked("thread-b")],
    [301, marked("thread-b")],
    [302, marked("thread-b")],
    [400, marked("thread-c")],
    [401, marked("thread-c")],
    [500, legacy],
    [501, legacy],
    [502, legacy],
  ]);

  const build = (overrides?: { readonly now?: number }) =>
    buildAgentProcesses({
      table,
      envByPid,
      serverPid: SERVER_PID,
      providerPids: new Set([400]),
      listeningPortsByPid: new Map([
        [302, [4000]],
        [502, [3300]],
        [501, [3300]],
        [SERVER_PID, [1337]],
      ]),
      now: overrides?.now ?? NOW,
    });

  it("lists one entry per chain and never the provider CLIs themselves", () => {
    expect(build().map((entry) => entry.rootPid)).toEqual([500, 302, 401]);
  });

  it("marks a chain the OS reparented as orphaned and keeps the provider session id", () => {
    expect(build().find((entry) => entry.rootPid === 500)).toMatchObject({
      threadId: null,
      providerSessionId: "b8c107fe-1b2d-45a3-b50d-409f27f5cba1",
      orphaned: true,
      command: "node /home/tomo/.local/bin/pnpm dev",
      pids: [500, 501, 502],
      listeningPorts: [3300],
      uptimeMs: 4_210_000,
    });
  });

  it("attributes a chain below a running provider CLI to its thread", () => {
    expect(build().find((entry) => entry.rootPid === 302)).toMatchObject({
      threadId: "thread-b",
      orphaned: false,
      listeningPorts: [4000],
      pids: [302],
    });
  });

  it("treats a registered pid as the provider CLI, so its child is the chain root", () => {
    expect(build().find((entry) => entry.rootPid === 401)).toMatchObject({
      threadId: "thread-c",
      orphaned: false,
    });
  });

  it("hides a young chain of a running turn but never a young orphan", () => {
    expect(build().some((entry) => entry.rootPid === 210)).toBe(false);
    const withYoungOrphan = buildAgentProcesses({
      table: [...table, row(600, 1, "node watch.js", 1)],
      envByPid: new Map([...envByPid, [600, marked("thread-a")]]),
      serverPid: SERVER_PID,
      providerPids: new Set([400]),
      listeningPortsByPid: new Map(),
      now: NOW,
    });
    expect(withYoungOrphan.some((entry) => entry.rootPid === 600)).toBe(true);
  });

  it("sorts by start time, oldest first, and reports a stable startedAt", () => {
    const processes = build();
    const startedAt = processes.map((entry) => entry.startedAt);
    expect(startedAt).toEqual([...startedAt].sort());
    expect(processes[0]?.startedAt).toBe(agentProcessStartedAt(NOW, 4210));
    // A second scan a moment later reports the same identity.
    expect(build({ now: NOW + 400 })[0]?.startedAt).toBe(processes[0]?.startedAt);
  });
});

describe("selectStopTarget", () => {
  const processes = buildAgentProcesses({
    table: [row(SERVER_PID, 1, "node t3 server"), row(500, 1, "pnpm dev", 4210)],
    envByPid: new Map([[500, marked("thread-a")]]),
    serverPid: SERVER_PID,
    providerPids: new Set(),
    listeningPortsByPid: new Map(),
    now: NOW,
  });

  it("matches a chain whose rounded start drifted by a second", () => {
    expect(
      selectStopTarget(processes, {
        rootPid: 500,
        startedAt: agentProcessStartedAt(NOW + 1_000, 4210),
      }),
    ).toBe(processes[0]);
  });

  it("reports a reused pid or a vanished chain as stale", () => {
    expect(
      selectStopTarget(processes, { rootPid: 500, startedAt: "2026-01-01T12:00:00.000Z" }),
    ).toBeNull();
    expect(
      selectStopTarget(processes, { rootPid: 501, startedAt: agentProcessStartedAt(NOW, 4210) }),
    ).toBeNull();
  });
});
