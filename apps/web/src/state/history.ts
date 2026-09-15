/**
 * Project history state.
 *
 * One environment answers for one project and window, so unlike usage there is
 * nothing to merge. The wrapper exists to keep the page free of AsyncResult
 * handling and to give it a refresh that works while nothing is selected.
 *
 * @module state/history
 */
import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId, ProjectHistory, ProjectHistoryInput } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/unstable/reactivity";
import { useCallback, useMemo } from "react";

import { appAtomRegistry } from "../rpc/atomRegistry";
import { serverEnvironment } from "./server";

export interface ProjectHistoryView {
  readonly history: ProjectHistory | null;
  readonly isPending: boolean;
  readonly error: string | null;
  readonly refresh: () => void;
}

interface ProjectHistoryState {
  readonly history: ProjectHistory | null;
  readonly isPending: boolean;
  readonly error: string | null;
}

const EMPTY_STATE: ProjectHistoryState = { history: null, isPending: false, error: null };
const EMPTY_HISTORY_ATOM = Atom.make(EMPTY_STATE).pipe(Atom.withLabel("web-history:empty"));

interface HistoryTarget {
  readonly environmentId: EnvironmentId;
  readonly input: ProjectHistoryInput;
}

/**
 * Keyed by the serialised target so the page can hand over a fresh object each
 * render without thrashing the query atom behind it.
 */
const historyByTargetAtom = Atom.family((targetKey: string) =>
  Atom.make((get): ProjectHistoryState => {
    const target = JSON.parse(targetKey) as HistoryTarget;
    const result = get(serverEnvironment.projectHistory(target));
    return {
      history: Option.getOrNull(AsyncResult.value(result)),
      isPending: result.waiting,
      error: result._tag === "Failure" ? "This environment could not report history." : null,
    };
  }).pipe(Atom.withLabel(`web-history:target:${targetKey}`)),
);

export function useProjectHistory(target: HistoryTarget | null): ProjectHistoryView {
  // Callers memoise their target, so keying off the object is enough. The
  // fixed field order matters: both the read and the refresh below rebuild the
  // query target from this string, so they land on the same family entry.
  const targetKey = useMemo(
    () =>
      target === null
        ? null
        : JSON.stringify({
            environmentId: target.environmentId,
            input: {
              projectId: target.input.projectId,
              sinceDay: target.input.sinceDay,
              untilDay: target.input.untilDay,
              timeZone: target.input.timeZone,
            },
          }),
    [target],
  );
  const state = useAtomValue(
    targetKey === null ? EMPTY_HISTORY_ATOM : historyByTargetAtom(targetKey),
  );

  const refresh = useCallback(() => {
    if (targetKey === null) return;
    appAtomRegistry.refresh(
      serverEnvironment.projectHistory(JSON.parse(targetKey) as HistoryTarget),
    );
  }, [targetKey]);

  return { ...state, refresh };
}
