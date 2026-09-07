import type { EnvironmentId, LinearIssueDetail, ThreadId } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Option from "effect/Option";
import { AsyncResult } from "effect/unstable/reactivity";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { useCallback, useState } from "react";

import { appAtomRegistry } from "../rpc/atomRegistry";
import { linearEnvironment } from "./linear";
import { useEnvironmentQuery } from "./query";
import { useAtomCommand } from "./use-atom-command";

export interface LinearIssueThreadScope {
  readonly environmentId: EnvironmentId | null;
  readonly cwd: string | null;
}

/**
 * Checking out an issue's branch, with the pending and error state the dialog
 * renders.
 *
 * Unlike the pull-request equivalent this does not register with the shared
 * VCS action manager: the manager's operation list is a wire contract, and the
 * only surface that reports this action is the dialog that started it.
 */
export function usePrepareIssueThreadAction(scope: LinearIssueThreadScope) {
  const prepareIssueThread = useAtomCommand(linearEnvironment.prepareIssueThread, {
    reportFailure: false,
  });
  const [isPending, setIsPending] = useState(false);
  const [error, setError] = useState<unknown>(null);

  const resetError = useCallback(() => {
    setError(null);
  }, []);

  const run = useCallback(
    async (input: {
      reference: string;
      mode: "local" | "worktree";
      /** Omitted when the dialog left the branch to the server's naming setting. */
      branch?: string;
      threadId?: ThreadId;
    }) => {
      if (scope.environmentId === null || scope.cwd === null) {
        const unavailable = new Error("No project is available to start an issue thread in.");
        setError(unavailable);
        return AsyncResult.failure<never, Error>(Cause.fail(unavailable));
      }
      setIsPending(true);
      setError(null);
      const result = await prepareIssueThread({
        environmentId: scope.environmentId,
        input: {
          cwd: scope.cwd,
          reference: input.reference,
          mode: input.mode,
          ...(input.branch ? { branch: input.branch } : {}),
          ...(input.threadId ? { threadId: input.threadId } : {}),
        },
      });
      setIsPending(false);
      if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
        setError(squashAtomCommandFailure(result));
      }
      return result;
    },
    [prepareIssueThread, scope.cwd, scope.environmentId],
  );

  return { error, isPending, resetError, run };
}

export interface LinearIssueResolutionTarget {
  readonly environmentId: EnvironmentId | null;
  readonly reference: string | null;
}

/** The last answer for this identifier, so retyping the same reference does not blank the row. */
export function readCachedLinearIssue(
  target: LinearIssueResolutionTarget,
): LinearIssueDetail | null {
  if (target.environmentId === null || target.reference === null) {
    return null;
  }
  return Option.getOrNull(
    AsyncResult.value(
      appAtomRegistry.get(
        linearEnvironment.issue({
          environmentId: target.environmentId,
          input: { reference: target.reference },
        }),
      ),
    ),
  );
}

/**
 * The issue behind a typed reference. Callers pass the debounced reference so
 * a request is not made per keystroke, and the cached answer keeps the row on
 * screen while the next one is in flight.
 */
export function useLinearIssueResolution(target: LinearIssueResolutionTarget) {
  const query = useEnvironmentQuery(
    target.environmentId !== null && target.reference !== null
      ? linearEnvironment.issue({
          environmentId: target.environmentId,
          input: { reference: target.reference },
        })
      : null,
  );
  const cached = readCachedLinearIssue(target);

  return {
    data: query.data ?? cached,
    error: query.error,
    isPending: query.isPending && cached === null,
    isFetching: query.isPending,
    refresh: query.refresh,
  };
}
