/**
 * Pids of the provider CLIs the server is currently running.
 *
 * The server's leftover-process scanner (`apps/server/src/agentProcesses`)
 * infers provider roots from the process tree, which misses a session whose
 * spawn inserted extra processes. Spawn sites that know their pid register it
 * here so the scanner excludes it exactly instead of guessing, and never
 * offers a live session as a leftover to stop.
 *
 * Module-level rather than a service: the spawn sites sit deep inside the
 * provider runtimes, in packages that cannot reach the server's services.
 */
import * as Effect from "effect/Effect";
import type * as Scope from "effect/Scope";

const providerProcesses = new Set<number>();

export function snapshot(): ReadonlySet<number> {
  return new Set(providerProcesses);
}

/**
 * Registers a provider pid and returns its release, for spawn sites outside
 * Effect that tie the registration to the child's own exit.
 */
export function register(pid: number | undefined): () => void {
  if (pid === undefined || !Number.isInteger(pid) || pid <= 1) return () => {};
  providerProcesses.add(pid);
  return () => {
    providerProcesses.delete(pid);
  };
}

/** Registers a provider pid for the lifetime of the enclosing scope. */
export const retain = (pid: number): Effect.Effect<void, never, Scope.Scope> =>
  Effect.acquireRelease(
    Effect.sync(() => register(pid)),
    (release) => Effect.sync(release),
  );
