/**
 * Every provider session (Codex app-server, Claude Code CLI, ACP agents) is
 * spawned with this variable set to the T3 thread id. Child processes inherit
 * their parent's environment, so a dev server the agent starts in the
 * background still carries the marker after the CLI exits and the OS
 * reparents it. The server scans process environments for the marker to list
 * and stop those leftovers; see `apps/server/src/agentProcesses`.
 */
export const AGENT_PROCESS_THREAD_ENV = "T3CODE_THREAD_ID";

/**
 * Thread ids are opaque strings. The marker travels through `ps -E` output on
 * macOS, where it is split on whitespace, so a value with whitespace would be
 * unrecoverable; ids never contain it, and a stray one is treated as absent.
 */
export function withAgentProcessMarker<Env extends Record<string, string | undefined>>(
  env: Env,
  threadId: string,
): Env & { readonly [AGENT_PROCESS_THREAD_ENV]: string } {
  return { ...env, [AGENT_PROCESS_THREAD_ENV]: threadId };
}

/** Reads the marker out of a whitespace-separated environment dump. */
export function readAgentProcessMarker(entries: Iterable<string>): string | undefined {
  const prefix = `${AGENT_PROCESS_THREAD_ENV}=`;
  for (const entry of entries) {
    if (!entry.startsWith(prefix)) continue;
    const value = entry.slice(prefix.length).trim();
    if (value.length > 0 && !/\s/.test(value)) return value;
    return undefined;
  }
  return undefined;
}
