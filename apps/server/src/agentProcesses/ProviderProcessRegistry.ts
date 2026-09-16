/**
 * Pids of the provider CLIs the server is currently running.
 *
 * The scanner infers provider roots from the process tree (a direct child of
 * the server, or a wrapper below one), which misses a session whose spawn
 * inserted extra processes. Spawn sites that know their pid register it here
 * so the scanner excludes it exactly instead of guessing, and never offers a
 * live session as a leftover to stop.
 *
 * Module-level rather than a service: the spawn sites sit deep inside the
 * provider runtimes, which would otherwise have to thread the tracker service
 * through every layer that builds them.
 */
import * as Effect from "effect/Effect";
import type * as Scope from "effect/Scope";

const providerProcesses = new Set<number>();

export function snapshot(): ReadonlySet<number> {
  return new Set(providerProcesses);
}

/** Registers a provider pid for the lifetime of the enclosing scope. */
export const retain = (pid: number): Effect.Effect<void, never, Scope.Scope> =>
  Effect.acquireRelease(
    Effect.sync(() => {
      if (Number.isInteger(pid) && pid > 1) providerProcesses.add(pid);
    }),
    () =>
      Effect.sync(() => {
        providerProcesses.delete(pid);
      }),
  );
