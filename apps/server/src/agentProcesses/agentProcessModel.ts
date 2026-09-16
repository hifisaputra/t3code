/**
 * Pure model behind `AgentProcessTracker`: everything between the raw output
 * of `ps` / `/proc` and the `AgentProcess` list the client sees. Kept free of
 * IO so the attribution and chain rules can be tested against recorded
 * process tables.
 */
import { ThreadId, type AgentProcess, type StopAgentProcessInput } from "@t3tools/contracts";
import { readAgentProcessMarker } from "@t3tools/shared/agentProcessMarker";
import * as DateTime from "effect/DateTime";

/** Claude Code's SDK entrypoint, set by the CLI the server spawns. */
const CLAUDE_ENTRYPOINT_ENV = "CLAUDE_CODE_ENTRYPOINT";
const CLAUDE_SDK_ENTRYPOINT = "sdk-ts";
const CLAUDE_SESSION_ENV = "CLAUDE_CODE_SESSION_ID";
/** Every variable the server exports into a provider session starts with this. */
const SERVER_ENV_PREFIX = "T3CODE_";

/** Matches the contract's `command`, which the server is expected to truncate. */
const MAX_COMMAND_LENGTH = 512;

/**
 * A chain younger than this is almost always a tool command of the running
 * turn (a build, a test run), not a leftover. Orphans are listed immediately:
 * their provider CLI is already gone, so nothing will clean them up.
 */
const MIN_CHAIN_AGE_SECONDS = 5;

/** `startedAt` values are rounded to the second, so a stop tolerates drift. */
const STARTED_AT_TOLERANCE_MS = 1_000;

/**
 * Words that identify a provider CLI inside a wrapper command line such as
 * `sh -c 'codex app-server'`. Matched as whole path segments or words so a
 * project directory named `codex-ui` does not hide a dev server.
 */
const PROVIDER_COMMAND_WORDS: ReadonlyArray<string> = [
  "claude",
  "codex",
  "cursor",
  "cursor-agent",
  "grok",
  "antigravity",
];

export interface ProcessTableRow {
  readonly pid: number;
  readonly ppid: number;
  /** Null when the platform reports no process group (or reports 0). */
  readonly pgid: number | null;
  /** Whole seconds since the process started, as `ps -o etimes=` reports. */
  readonly etimeSeconds: number;
  readonly args: string;
}

export interface AgentProcessAttribution {
  /** Null for a legacy chain recognised by the provider's own variables. */
  readonly threadId: ThreadId | null;
  readonly providerSessionId: string | null;
}

export interface BuildAgentProcessesInput {
  readonly table: ReadonlyArray<ProcessTableRow>;
  /** Environment entries (`KEY=value`) per pid whose environment was readable. */
  readonly envByPid: ReadonlyMap<number, ReadonlyArray<string>>;
  readonly serverPid: number;
  /** Pids the spawn sites registered; these are provider CLIs exactly. */
  readonly providerPids: ReadonlySet<number>;
  readonly listeningPortsByPid: ReadonlyMap<number, ReadonlyArray<number>>;
  readonly cwdByPid?: ReadonlyMap<number, string>;
  readonly now: number;
}

/** Parses `ps -eo pid=,ppid=,pgid=,etimes=,args=` output. */
export function parsePsTable(raw: string): ReadonlyArray<ProcessTableRow> {
  const rows: Array<ProcessTableRow> = [];
  for (const line of raw.split("\n")) {
    const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/.exec(line);
    if (!match) continue;
    const [, pidRaw, ppidRaw, pgidRaw, etimeRaw, argsRaw] = match;
    const pid = Number.parseInt(pidRaw ?? "", 10);
    const ppid = Number.parseInt(ppidRaw ?? "", 10);
    const pgid = Number.parseInt(pgidRaw ?? "", 10);
    const etimeSeconds = Number.parseInt(etimeRaw ?? "", 10);
    const args = (argsRaw ?? "").trim();
    if (!Number.isInteger(pid) || pid <= 0) continue;
    if (!Number.isInteger(ppid) || ppid < 0) continue;
    if (!Number.isInteger(etimeSeconds) || etimeSeconds < 0) continue;
    if (args.length === 0) continue;
    rows.push({
      pid,
      ppid,
      pgid: Number.isInteger(pgid) && pgid > 0 ? pgid : null,
      etimeSeconds,
      args,
    });
  }
  return rows;
}

/** Splits the NUL-separated body of `/proc/<pid>/environ`. */
export function parseEnviron(raw: string): ReadonlyArray<string> {
  return raw.split("\0").filter((entry) => entry.length > 0);
}

/**
 * Parses macOS `ps -Eww -o pid=,command= -p <pids>`, where the environment is
 * appended to the command line. The whole remainder is scanned as whitespace
 * separated tokens: telling the command from the environment needs a shell
 * parse, and a `KEY=value` token that is really an argument is harmless here.
 */
export function parsePsEnvironmentDump(raw: string): ReadonlyMap<number, ReadonlyArray<string>> {
  const byPid = new Map<number, ReadonlyArray<string>>();
  for (const line of raw.split("\n")) {
    const match = /^\s*(\d+)\s+(.*)$/.exec(line);
    if (!match) continue;
    const pid = Number.parseInt(match[1] ?? "", 10);
    if (!Number.isInteger(pid) || pid <= 0) continue;
    byPid.set(
      pid,
      (match[2] ?? "").split(/\s+/).filter((token) => token.length > 0),
    );
  }
  return byPid;
}

/**
 * Parses `lsof -iTCP -sTCP:LISTEN -P -n -F pcn`: a `p` record opens a process
 * and each following `n` record is one of its listening addresses.
 */
export function parseLsofListeners(raw: string): ReadonlyMap<number, ReadonlyArray<number>> {
  const byPid = new Map<number, Array<number>>();
  let pid: number | null = null;
  for (const line of raw.split("\n")) {
    if (line.length === 0) continue;
    const value = line.slice(1);
    if (line.charAt(0) === "p") {
      const parsed = Number.parseInt(value, 10);
      pid = Number.isInteger(parsed) && parsed > 0 ? parsed : null;
      continue;
    }
    if (line.charAt(0) !== "n" || pid === null) continue;
    addListeningPort(byPid, pid, value.split(" ", 1)[0] ?? "");
  }
  return byPid;
}

/**
 * Parses `ss -H -ltnp`. Linux `lsof` misses sockets on this box's IPv6
 * wildcard listeners, and `ss` is the kernel's own view, so it is preferred
 * where it exists.
 */
export function parseSsListeners(raw: string): ReadonlyMap<number, ReadonlyArray<number>> {
  const byPid = new Map<number, Array<number>>();
  for (const line of raw.split("\n")) {
    const address = /^\s*\S+\s+\S+\s+\S+\s+(\S+)/.exec(line)?.[1];
    if (address === undefined) continue;
    for (const owner of line.matchAll(/pid=(\d+)/g)) {
      const pid = Number.parseInt(owner[1] ?? "", 10);
      if (Number.isInteger(pid) && pid > 0) addListeningPort(byPid, pid, address);
    }
  }
  return byPid;
}

function addListeningPort(byPid: Map<number, Array<number>>, pid: number, address: string): void {
  const lastColon = address.lastIndexOf(":");
  if (lastColon < 0) return;
  const port = Number.parseInt(address.slice(lastColon + 1), 10);
  if (!Number.isInteger(port) || port <= 0 || port >= 65536) return;
  const ports = byPid.get(pid);
  if (ports) {
    if (!ports.includes(port)) ports.push(port);
  } else byPid.set(pid, [port]);
}

/**
 * Decides whether an environment belongs to an agent session, and to which
 * thread. The marker is authoritative; the legacy shape (Claude Code's SDK
 * entrypoint next to the server's own variables) catches chains started
 * before the marker existed, which can only be attributed to a provider
 * session, not to a thread.
 */
export function attributeAgentProcess(
  entries: ReadonlyArray<string>,
): AgentProcessAttribution | null {
  const marker = readAgentProcessMarker(entries);
  let claudeSdkEntrypoint = false;
  let hasServerEnv = false;
  let providerSessionId: string | null = null;
  for (const entry of entries) {
    if (entry === `${CLAUDE_ENTRYPOINT_ENV}=${CLAUDE_SDK_ENTRYPOINT}`) claudeSdkEntrypoint = true;
    else if (entry.startsWith(SERVER_ENV_PREFIX)) hasServerEnv = true;
    else if (entry.startsWith(`${CLAUDE_SESSION_ENV}=`)) {
      const value = entry.slice(CLAUDE_SESSION_ENV.length + 1).trim();
      if (value.length > 0) providerSessionId = value;
    }
  }
  if (marker !== undefined) return { threadId: ThreadId.make(marker), providerSessionId };
  if (claudeSdkEntrypoint && hasServerEnv) return { threadId: null, providerSessionId };
  return null;
}

function mentionsProviderCommand(args: string): boolean {
  for (const word of PROVIDER_COMMAND_WORDS) {
    // Path segments (`/usr/bin/codex`) and bare words (`sh -c "codex app-server"`).
    const pattern = new RegExp(`(^|[\\s/"'=])${word}($|[\\s"'])`);
    if (pattern.test(args)) return true;
  }
  return false;
}

/**
 * Derives a start timestamp from an elapsed-seconds reading. Rounding to the
 * second keeps the value stable across scans so the client can use it as the
 * identity of a chain (and a stop can detect pid reuse).
 */
export function agentProcessStartedAt(nowMs: number, etimeSeconds: number): string {
  return DateTime.formatIso(DateTime.makeUnsafe(Math.round(nowMs / 1000 - etimeSeconds) * 1000));
}

/** True when two rounded `startedAt` readings describe the same process start. */
function startedAtMatches(left: string, right: string): boolean {
  if (left === right) return true;
  const leftMs = Date.parse(left);
  const rightMs = Date.parse(right);
  if (Number.isNaN(leftMs) || Number.isNaN(rightMs)) return false;
  return Math.abs(leftMs - rightMs) <= STARTED_AT_TOLERANCE_MS;
}

/** The chain a stop request names, or null when it is gone or the pid was reused. */
export function selectStopTarget(
  processes: ReadonlyArray<AgentProcess>,
  input: Pick<StopAgentProcessInput, "rootPid" | "startedAt">,
): AgentProcess | null {
  return (
    processes.find(
      (entry) =>
        entry.rootPid === input.rootPid && startedAtMatches(entry.startedAt, input.startedAt),
    ) ?? null
  );
}

export function buildAgentProcesses(input: BuildAgentProcessesInput): ReadonlyArray<AgentProcess> {
  const rows = new Map<number, ProcessTableRow>();
  for (const row of input.table) rows.set(row.pid, row);

  const attribution = new Map<number, AgentProcessAttribution>();
  for (const [pid, entries] of input.envByPid) {
    if (!rows.has(pid)) continue;
    const attributed = attributeAgentProcess(entries);
    if (attributed !== null) attribution.set(pid, attributed);
  }

  const children = new Map<number, Array<number>>();
  for (const row of rows.values()) {
    const siblings = children.get(row.ppid);
    if (siblings) siblings.push(row.pid);
    else children.set(row.ppid, [row.pid]);
  }

  // A provider CLI is a direct child of the server, or a registered pid, or a
  // wrapper below one of those that still names a provider binary. Those are
  // the session itself, never a leftover, so they are never listed.
  const providerRoots = new Set<number>(input.providerPids);
  for (const pid of attribution.keys()) {
    if (rows.get(pid)?.ppid === input.serverPid) providerRoots.add(pid);
  }
  const pending = [...providerRoots];
  for (let index = 0; index < pending.length; index += 1) {
    const parent = pending[index];
    if (parent === undefined) continue;
    for (const child of children.get(parent) ?? []) {
      if (providerRoots.has(child) || !attribution.has(child)) continue;
      const row = rows.get(child);
      if (!row || !mentionsProviderCommand(row.args)) continue;
      providerRoots.add(child);
      pending.push(child);
    }
  }

  const collectChain = (rootPid: number): ReadonlyArray<number> => {
    const chain = [rootPid];
    for (let index = 0; index < chain.length; index += 1) {
      const pid = chain[index];
      if (pid === undefined) continue;
      for (const child of children.get(pid) ?? []) {
        if (chain.includes(child)) continue;
        if (providerRoots.has(child) || !attribution.has(child)) continue;
        chain.push(child);
      }
    }
    return chain;
  };

  const processes: Array<AgentProcess> = [];
  for (const [pid, attributed] of attribution) {
    if (providerRoots.has(pid) || pid <= 1 || pid === input.serverPid) continue;
    const row = rows.get(pid);
    if (!row) continue;
    const parentIsProviderRoot = providerRoots.has(row.ppid);
    // A process below another agent-owned process is part of that chain.
    if (!parentIsProviderRoot && attribution.has(row.ppid)) continue;
    const orphaned = !parentIsProviderRoot;
    if (!orphaned && row.etimeSeconds < MIN_CHAIN_AGE_SECONDS) continue;
    const command = row.args.slice(0, MAX_COMMAND_LENGTH).trim();
    if (command.length === 0) continue;
    const pids = collectChain(pid);
    const ports = new Set<number>();
    for (const chainPid of pids) {
      for (const port of input.listeningPortsByPid.get(chainPid) ?? []) {
        if (Number.isInteger(port) && port > 0 && port < 65536) ports.add(port);
      }
    }
    processes.push({
      rootPid: pid,
      pgid: row.pgid,
      threadId: attributed.threadId,
      providerSessionId: attributed.providerSessionId,
      command,
      cwd: input.cwdByPid?.get(pid) ?? null,
      startedAt: agentProcessStartedAt(input.now, row.etimeSeconds),
      uptimeMs: row.etimeSeconds * 1000,
      orphaned,
      listeningPorts: [...ports].toSorted((left, right) => left - right),
      pids,
    });
  }

  return processes.toSorted(
    (left, right) =>
      Date.parse(left.startedAt) - Date.parse(right.startedAt) || left.rootPid - right.rootPid,
  );
}

/** Identity of a snapshot for change detection; uptime alone never counts. */
export function agentProcessesFingerprint(processes: ReadonlyArray<AgentProcess>): string {
  return JSON.stringify(processes.map(({ uptimeMs: _uptimeMs, ...rest }) => rest));
}
