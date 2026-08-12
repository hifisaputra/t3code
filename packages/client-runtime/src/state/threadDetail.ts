import type {
  OrchestrationCheckpointSummary,
  OrchestrationLatestTurn,
  OrchestrationMessage,
  OrchestrationProposedPlan,
  OrchestrationSession,
  OrchestrationThread,
  OrchestrationThreadActivity,
  ScopedThreadRef,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/unstable/reactivity";

import type { EnvironmentThread, EnvironmentThreadShell } from "./models.ts";
import { scopeThread } from "./models.ts";
import { EMPTY_ENVIRONMENT_THREAD_STATE, type EnvironmentThreadState } from "./threadState.ts";
import { parseThreadKey, threadKey } from "./entities.ts";
import { THREAD_STATE_IDLE_TTL_MS } from "./threadRetention.ts";

const EMPTY_MESSAGES: ReadonlyArray<OrchestrationMessage> = Object.freeze([]);
const EMPTY_ACTIVITIES: ReadonlyArray<OrchestrationThreadActivity> = Object.freeze([]);
const EMPTY_PROPOSED_PLANS: ReadonlyArray<OrchestrationProposedPlan> = Object.freeze([]);
const EMPTY_CHECKPOINTS: ReadonlyArray<OrchestrationCheckpointSummary> = Object.freeze([]);

interface ThreadLifecycle {
  readonly session: OrchestrationSession | null;
  readonly latestTurn: OrchestrationLatestTurn | null;
}

/**
 * True when ISO timestamp `a` is strictly later than `b`. Both are server-stamped
 * so they share a clock; parse to epoch millis so mixed second/millisecond
 * precision (e.g. `…:00Z` vs `…:00.500Z`) orders correctly instead of by the
 * lexical accident that `Z` > `.`. Unparseable input falls back to lexical order,
 * which is still correct for well-formed ISO-8601 UTC strings.
 */
function isStrictlyAfter(a: string, b: string): boolean {
  const at = Date.parse(a);
  const bt = Date.parse(b);
  if (Number.isNaN(at) || Number.isNaN(bt)) {
    return a > b;
  }
  return at > bt;
}

/**
 * Pick the fresher turn lifecycle between the detail and shell channels.
 *
 * The session status and latest turn are replicated over both the per-thread
 * detail subscription and the sidebar shell stream. The detail subscription
 * applies `thread.session-set` directly and commonly observes the running→ready
 * transition first; the shell stream re-derives it from a coarse, reconnect-prone
 * feed that (on a slow link) can fail to deliver the terminal event, leaving the
 * composer stuck showing "stop" until a manual refresh reloads the shell snapshot.
 *
 * Both channels carry the same server-stamped `session.updatedAt`, so the newer
 * one wins. The shell wins ties (equal `updatedAt` ⇒ identical session) so this is
 * a no-op whenever the two are in sync, and it preserves the "stale detail after
 * reconnect yields to a newer shell" guarantee (a stale detail has an older
 * timestamp). `latestTurn` travels with the chosen session so the two never
 * disagree — e.g. a "ready" session paired with a still-"running" latest turn.
 */
function freshestLifecycle(
  detail: EnvironmentThread,
  shell: EnvironmentThreadShell,
): ThreadLifecycle {
  const detailSession = detail.session;
  const shellSession = shell.session;
  if (detailSession === null) {
    return { session: shellSession, latestTurn: shell.latestTurn };
  }
  if (shellSession === null) {
    return { session: detailSession, latestTurn: detail.latestTurn };
  }
  return isStrictlyAfter(detailSession.updatedAt, shellSession.updatedAt)
    ? { session: detailSession, latestTurn: detail.latestTurn }
    : { session: shellSession, latestTurn: shell.latestTurn };
}

/**
 * Combine detail-only collections with the shell's authoritative thread metadata.
 *
 * Shell and detail subscriptions are intentionally independent. A cached detail can
 * therefore briefly outlive a newer shell snapshot after reconnecting. Workspace
 * consumers must use the shell branch/worktree/project fields so they do not target
 * a stale checkout while retaining messages, activities, plans, and checkpoints
 * from the detail subscription.
 *
 * The turn lifecycle (session + latestTurn) is the exception: it is a value
 * replicated over both channels rather than shell-only metadata, so it must reflect
 * whichever channel observed the newer state — see {@link freshestLifecycle}.
 */
export function mergeEnvironmentThread(
  detail: EnvironmentThread | null,
  shell: EnvironmentThreadShell | null,
): EnvironmentThread | null {
  if (detail === null || shell === null) {
    return detail;
  }
  if (detail.environmentId !== shell.environmentId || detail.id !== shell.id) {
    return detail;
  }

  const lifecycle = freshestLifecycle(detail, shell);

  return {
    ...detail,
    environmentId: shell.environmentId,
    id: shell.id,
    projectId: shell.projectId,
    title: shell.title,
    modelSelection: shell.modelSelection,
    runtimeMode: shell.runtimeMode,
    interactionMode: shell.interactionMode,
    branch: shell.branch,
    worktreePath: shell.worktreePath,
    latestTurn: lifecycle.latestTurn,
    createdAt: shell.createdAt,
    updatedAt: shell.updatedAt,
    archivedAt: shell.archivedAt,
    settledOverride: shell.settledOverride,
    settledAt: shell.settledAt,
    snoozedUntil: shell.snoozedUntil,
    snoozedAt: shell.snoozedAt,
    pinnedAt: shell.pinnedAt,
    pinOrderKey: shell.pinOrderKey,
    // `lifecycle` picks the fresher of the detail and shell channels; see
    // pickFresherLifecycle above.
    session: lifecycle.session,
  };
}

export function createEnvironmentThreadDetailAtoms<E>(
  threadStateAtom: (
    environmentId: ScopedThreadRef["environmentId"],
    threadId: ScopedThreadRef["threadId"],
  ) => Atom.Atom<AsyncResult.AsyncResult<EnvironmentThreadState, E>>,
) {
  const threadStateValueAtomFamily = Atom.family((key: string) => {
    const ref = parseThreadKey(key);
    return Atom.make((get) =>
      Option.getOrElse(
        AsyncResult.value(get(threadStateAtom(ref.environmentId, ref.threadId))),
        () => EMPTY_ENVIRONMENT_THREAD_STATE,
      ),
    ).pipe(
      Atom.setIdleTTL(THREAD_STATE_IDLE_TTL_MS),
      Atom.withLabel(`environment-thread-state-value:${key}`),
    );
  });

  const threadDetailAtomFamily = Atom.family((key: string) => {
    const ref = parseThreadKey(key);
    let previousSource: OrchestrationThread | null = null;
    let previousValue: EnvironmentThread | null = null;
    return Atom.make((get) => {
      const source = Option.getOrNull(get(threadStateValueAtomFamily(key)).data);
      if (source === previousSource) {
        return previousValue;
      }
      previousSource = source;
      previousValue = source === null ? null : scopeThread(ref.environmentId, source);
      return previousValue;
    }).pipe(
      Atom.setIdleTTL(THREAD_STATE_IDLE_TTL_MS),
      Atom.withLabel(`environment-thread-detail:${key}`),
    );
  });

  const threadStatusAtomFamily = Atom.family((key: string) =>
    Atom.make((get) => get(threadStateValueAtomFamily(key)).status).pipe(
      Atom.setIdleTTL(THREAD_STATE_IDLE_TTL_MS),
      Atom.withLabel(`environment-thread-status:${key}`),
    ),
  );

  const threadErrorAtomFamily = Atom.family((key: string) =>
    Atom.make((get) => Option.getOrNull(get(threadStateValueAtomFamily(key)).error)).pipe(
      Atom.setIdleTTL(THREAD_STATE_IDLE_TTL_MS),
      Atom.withLabel(`environment-thread-error:${key}`),
    ),
  );

  const threadMessagesAtomFamily = Atom.family((key: string) =>
    Atom.make(
      (get): ReadonlyArray<OrchestrationMessage> =>
        get(threadDetailAtomFamily(key))?.messages ?? EMPTY_MESSAGES,
    ).pipe(
      Atom.setIdleTTL(THREAD_STATE_IDLE_TTL_MS),
      Atom.withLabel(`environment-thread-messages:${key}`),
    ),
  );

  const threadActivitiesAtomFamily = Atom.family((key: string) =>
    Atom.make(
      (get): ReadonlyArray<OrchestrationThreadActivity> =>
        get(threadDetailAtomFamily(key))?.activities ?? EMPTY_ACTIVITIES,
    ).pipe(
      Atom.setIdleTTL(THREAD_STATE_IDLE_TTL_MS),
      Atom.withLabel(`environment-thread-activities:${key}`),
    ),
  );

  const threadProposedPlansAtomFamily = Atom.family((key: string) =>
    Atom.make(
      (get): ReadonlyArray<OrchestrationProposedPlan> =>
        get(threadDetailAtomFamily(key))?.proposedPlans ?? EMPTY_PROPOSED_PLANS,
    ).pipe(
      Atom.setIdleTTL(THREAD_STATE_IDLE_TTL_MS),
      Atom.withLabel(`environment-thread-proposed-plans:${key}`),
    ),
  );

  const threadCheckpointsAtomFamily = Atom.family((key: string) =>
    Atom.make(
      (get): ReadonlyArray<OrchestrationCheckpointSummary> =>
        get(threadDetailAtomFamily(key))?.checkpoints ?? EMPTY_CHECKPOINTS,
    ).pipe(
      Atom.setIdleTTL(THREAD_STATE_IDLE_TTL_MS),
      Atom.withLabel(`environment-thread-checkpoints:${key}`),
    ),
  );

  const threadSessionAtomFamily = Atom.family((key: string) =>
    Atom.make(
      (get): OrchestrationSession | null => get(threadDetailAtomFamily(key))?.session ?? null,
    ).pipe(
      Atom.setIdleTTL(THREAD_STATE_IDLE_TTL_MS),
      Atom.withLabel(`environment-thread-session:${key}`),
    ),
  );

  const threadLatestTurnAtomFamily = Atom.family((key: string) =>
    Atom.make(
      (get): OrchestrationLatestTurn | null => get(threadDetailAtomFamily(key))?.latestTurn ?? null,
    ).pipe(
      Atom.setIdleTTL(THREAD_STATE_IDLE_TTL_MS),
      Atom.withLabel(`environment-thread-latest-turn:${key}`),
    ),
  );

  return {
    stateAtom: (ref: ScopedThreadRef) => threadStateValueAtomFamily(threadKey(ref)),
    detailAtom: (ref: ScopedThreadRef) => threadDetailAtomFamily(threadKey(ref)),
    statusAtom: (ref: ScopedThreadRef) => threadStatusAtomFamily(threadKey(ref)),
    errorAtom: (ref: ScopedThreadRef) => threadErrorAtomFamily(threadKey(ref)),
    messagesAtom: (ref: ScopedThreadRef) => threadMessagesAtomFamily(threadKey(ref)),
    activitiesAtom: (ref: ScopedThreadRef) => threadActivitiesAtomFamily(threadKey(ref)),
    proposedPlansAtom: (ref: ScopedThreadRef) => threadProposedPlansAtomFamily(threadKey(ref)),
    checkpointsAtom: (ref: ScopedThreadRef) => threadCheckpointsAtomFamily(threadKey(ref)),
    sessionAtom: (ref: ScopedThreadRef) => threadSessionAtomFamily(threadKey(ref)),
    latestTurnAtom: (ref: ScopedThreadRef) => threadLatestTurnAtomFamily(threadKey(ref)),
  };
}
