/**
 * Stopping a chain an agent left running, shared by the Processes page and the
 * thread banner.
 *
 * The result is per-row state rather than a toast: the graceful stop can leave
 * survivors, and the offer to force them is only meaningful next to the row it
 * belongs to. A stop that worked leaves nothing behind — the next pushed
 * snapshot drops the row on its own.
 *
 * @module components/processes/useStopAgentProcess
 */
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { AgentProcess, EnvironmentId } from "@t3tools/contracts";
import { useCallback, useState } from "react";

import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";

export type AgentProcessStopStatus =
  | { readonly kind: "pending" }
  | { readonly kind: "survivors"; readonly survivors: ReadonlyArray<number> }
  | { readonly kind: "error"; readonly message: string };

/** Identity of one chain, including `startedAt` so a reused pid is a new row. */
export function agentProcessStopKey(
  environmentId: EnvironmentId,
  process: Pick<AgentProcess, "rootPid" | "startedAt">,
): string {
  return `${environmentId}:${process.rootPid}:${process.startedAt}`;
}

export interface StopAgentProcessController {
  readonly statuses: ReadonlyMap<string, AgentProcessStopStatus>;
  readonly stop: (
    environmentId: EnvironmentId,
    process: Pick<AgentProcess, "rootPid" | "startedAt">,
    options?: { readonly force?: boolean },
  ) => Promise<void>;
}

export function useStopAgentProcess(): StopAgentProcessController {
  const stopAgentProcess = useAtomCommand(serverEnvironment.stopAgentProcess, {
    reportFailure: false,
  });
  const [statuses, setStatuses] = useState<ReadonlyMap<string, AgentProcessStopStatus>>(
    () => new Map(),
  );

  const setStatus = useCallback((key: string, status: AgentProcessStopStatus | null) => {
    setStatuses((previous) => {
      if (status === null && !previous.has(key)) return previous;
      const next = new Map(previous);
      if (status === null) {
        next.delete(key);
      } else {
        next.set(key, status);
      }
      return next;
    });
  }, []);

  const stop = useCallback(
    async (
      environmentId: EnvironmentId,
      process: Pick<AgentProcess, "rootPid" | "startedAt">,
      options?: { readonly force?: boolean },
    ) => {
      const key = agentProcessStopKey(environmentId, process);
      setStatus(key, { kind: "pending" });
      const result = await stopAgentProcess({
        environmentId,
        input: {
          rootPid: process.rootPid,
          startedAt: process.startedAt,
          ...(options?.force === true ? { force: true } : {}),
        },
      });

      if (result._tag === "Failure") {
        // An interrupted command is a teardown, not a failure to report.
        if (isAtomCommandInterrupted(result)) {
          setStatus(key, null);
          return;
        }
        const error = squashAtomCommandFailure(result);
        setStatus(key, {
          kind: "error",
          message:
            error instanceof Error && error.message.trim().length > 0
              ? error.message
              : "Could not stop this process.",
        });
        return;
      }

      // Stale means the chain is already gone; either way the list refreshes.
      if (result.value.stale || result.value.survivors.length === 0) {
        setStatus(key, null);
        return;
      }
      setStatus(key, { kind: "survivors", survivors: result.value.survivors });
    },
    [setStatus, stopAgentProcess],
  );

  return { statuses, stop };
}
