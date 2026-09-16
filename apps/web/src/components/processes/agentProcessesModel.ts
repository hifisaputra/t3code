/**
 * Shaping for the Processes page: grouping, ordering, and the two labels that
 * need judgement (command line and uptime).
 *
 * Everything here is pure so the page can stay a renderer and the rules can be
 * tested without a server. Ordering puts the likeliest leftovers first: a chain
 * whose provider session is gone outranks one that may still belong to a
 * running turn, and within each of those the oldest runs first, because the
 * `pnpm dev` from this morning is the one the user forgot about.
 *
 * @module components/processes/agentProcessesModel
 */
import type { AgentProcess, EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";
import type {
  EnvironmentProject,
  EnvironmentThreadShell,
} from "@t3tools/client-runtime/state/models";

export interface AgentProcessEntry {
  readonly environmentId: EnvironmentId;
  readonly process: AgentProcess;
  readonly thread: EnvironmentThreadShell | null;
  readonly project: EnvironmentProject | null;
}

export interface AgentProcessThreadGroup {
  readonly key: string;
  readonly environmentId: EnvironmentId;
  /** Null for a leftover whose thread could not be resolved. */
  readonly threadId: ThreadId | null;
  readonly title: string;
  /** Only carried when there is no thread to link to. */
  readonly providerSessionId: string | null;
  readonly entries: ReadonlyArray<AgentProcessEntry>;
}

export interface AgentProcessProjectGroup {
  readonly key: string;
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId | null;
  readonly title: string;
  readonly threads: ReadonlyArray<AgentProcessThreadGroup>;
}

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

/**
 * How long the chain has been up, at the coarsest unit that still says
 * something. Seconds are kept below a minute so a process that just started
 * does not read as though it had been forgotten.
 */
export function formatUptime(uptimeMs: number): string {
  if (!Number.isFinite(uptimeMs) || uptimeMs < 0) return "0s";
  if (uptimeMs < MINUTE_MS) return `${Math.floor(uptimeMs / 1_000)}s`;
  if (uptimeMs < HOUR_MS) return `${Math.floor(uptimeMs / MINUTE_MS)}m`;
  if (uptimeMs < DAY_MS) {
    const hours = Math.floor(uptimeMs / HOUR_MS);
    const minutes = Math.floor((uptimeMs - hours * HOUR_MS) / MINUTE_MS);
    return minutes === 0 ? `${hours}h` : `${hours}h ${minutes}m`;
  }
  const days = Math.floor(uptimeMs / DAY_MS);
  const hours = Math.floor((uptimeMs - days * DAY_MS) / HOUR_MS);
  return hours === 0 ? `${days}d` : `${days}d ${hours}h`;
}

/** Trailing path segment, for cwd labels. Keeps the root as "/". */
export function pathBasename(path: string): string {
  const trimmed = path.replace(/[\\/]+$/, "");
  if (trimmed.length === 0) return path.length === 0 ? path : "/";
  const separator = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
  return separator === -1 ? trimmed : trimmed.slice(separator + 1);
}

const SHELL_WRAPPER = /^(?:[^\s]*\/)?(?:sh|bash|zsh|dash)$/;
const SHELL_COMMAND_FLAG = /^-[a-z]*c$/;

function unquote(value: string): string {
  const quote = value[0];
  if ((quote !== '"' && quote !== "'") || value.at(-1) !== quote || value.length < 2) return value;
  const inner = value.slice(1, -1);
  return inner.includes(quote) ? value : inner;
}

/**
 * The command as a single readable line. Agents launch through a shell and
 * through absolute interpreter paths, which pushes the part the user cares
 * about off the end of the row; the full line stays available as a tooltip.
 *
 * Splitting on whitespace is deliberate: this is a label, not a parse.
 */
export function shortenCommand(command: string): string {
  let rest = command.trim();
  // A wrapper can nest (`sh -c "bash -lc ..."`), so peel until none is left.
  for (;;) {
    const tokens = rest.split(/\s+/);
    const [binary, flag] = tokens;
    if (
      binary === undefined ||
      flag === undefined ||
      !SHELL_WRAPPER.test(binary) ||
      !SHELL_COMMAND_FLAG.test(flag)
    ) {
      break;
    }
    const next = unquote(tokens.slice(2).join(" ").trim());
    if (next.length === 0) break;
    rest = next;
  }

  const tokens = rest.split(/\s+/).filter((token) => token.length > 0);
  return tokens
    .map((token, index) =>
      index === 0 || token.includes("/node_modules/.bin/") ? pathBasename(token) : token,
    )
    .join(" ");
}

function entryRank(entry: AgentProcessEntry): [number, string] {
  return [entry.process.orphaned ? 0 : 1, entry.process.startedAt];
}

function compareEntries(a: AgentProcessEntry, b: AgentProcessEntry): number {
  const [orphanedA, startedA] = entryRank(a);
  const [orphanedB, startedB] = entryRank(b);
  if (orphanedA !== orphanedB) return orphanedA - orphanedB;
  if (startedA !== startedB) return startedA < startedB ? -1 : 1;
  return a.process.rootPid - b.process.rootPid;
}

function threadKey(entry: AgentProcessEntry): string {
  const { environmentId, process } = entry;
  if (process.threadId !== null) return `${environmentId}:thread:${process.threadId}`;
  // Leftovers with no thread still separate by session, so two forgotten
  // sessions do not merge into one heading.
  return `${environmentId}:session:${process.providerSessionId ?? "unknown"}`;
}

function threadTitle(entry: AgentProcessEntry): string {
  if (entry.process.threadId === null) return "Earlier session";
  return entry.thread?.title ?? "Untitled thread";
}

function projectKey(entry: AgentProcessEntry): string {
  const projectId = entry.project?.id ?? null;
  return projectId === null
    ? `${entry.environmentId}:no-project`
    : `${entry.environmentId}:project:${projectId}`;
}

/**
 * Groups by project, then by thread, keeping both levels in the order of their
 * most urgent row so the forgotten dev server is the first thing on the page.
 */
export function groupAgentProcesses(
  entries: ReadonlyArray<AgentProcessEntry>,
): ReadonlyArray<AgentProcessProjectGroup> {
  const sorted = [...entries].sort(compareEntries);

  const projects = new Map<
    string,
    {
      readonly environmentId: EnvironmentId;
      readonly projectId: ProjectId | null;
      readonly title: string;
      readonly threads: Map<string, AgentProcessEntry[]>;
    }
  >();

  for (const entry of sorted) {
    const project = projects.get(projectKey(entry)) ?? {
      environmentId: entry.environmentId,
      projectId: entry.project?.id ?? null,
      title: entry.project?.title ?? "Unknown project",
      threads: new Map<string, AgentProcessEntry[]>(),
    };
    projects.set(projectKey(entry), project);
    const thread = project.threads.get(threadKey(entry)) ?? [];
    thread.push(entry);
    project.threads.set(threadKey(entry), thread);
  }

  return [...projects].map(([key, project]) => ({
    key,
    environmentId: project.environmentId,
    projectId: project.projectId,
    title: project.title,
    threads: [...project.threads].map(([threadGroupKey, threadEntries]) => {
      const first = threadEntries[0] as AgentProcessEntry;
      return {
        key: threadGroupKey,
        environmentId: first.environmentId,
        threadId: first.process.threadId,
        title: threadTitle(first),
        providerSessionId: first.process.threadId === null ? first.process.providerSessionId : null,
        entries: threadEntries,
      };
    }),
  }));
}

/** "localhost:3300 · localhost:5173", capped so a banner stays one line. */
export function formatPortSummary(ports: ReadonlyArray<number>, limit = 3): string | null {
  if (ports.length === 0) return null;
  const shown = ports.slice(0, limit).map((port) => `localhost:${port}`);
  return ports.length > limit ? `${shown.join(" · ")} +${ports.length - limit}` : shown.join(" · ");
}

/** Every distinct listening port of a set of chains, ascending. */
export function collectListeningPorts(
  processes: ReadonlyArray<AgentProcess>,
): ReadonlyArray<number> {
  const ports = new Set<number>();
  for (const process of processes) {
    for (const port of process.listeningPorts) ports.add(port);
  }
  return [...ports].sort((a, b) => a - b);
}
