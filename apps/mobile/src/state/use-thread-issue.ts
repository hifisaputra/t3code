import { useAtomValue } from "@effect/atom-react";
import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import { Atom } from "effect/unstable/reactivity";
import { useCallback, useEffect, useMemo } from "react";

import { appAtomRegistry } from "./atom-registry";
import { linearEnvironment } from "./linear";
import { useEnvironmentQuery } from "./query";
import {
  presentThreadIssue,
  resolveThreadIssuePresentation,
  type ThreadIssuePresentation,
} from "./thread-issue-presentation";

const MAX_THREAD_ISSUE_SNAPSHOTS = 500;

interface ThreadIssueSnapshot {
  readonly identity: string;
  readonly presentation: ThreadIssuePresentation;
}

// One bounded cache survives row virtualization without retaining one live
// atom for every thread or issue ever seen.
const threadIssueSnapshotsAtom = Atom.make<ReadonlyMap<string, ThreadIssueSnapshot>>(
  new Map(),
).pipe(Atom.keepAlive, Atom.withLabel("mobile:thread-issue-snapshots"));

export {
  presentThreadIssue,
  presentLinkedThreadIssue,
  type ThreadIssuePresentation,
} from "./thread-issue-presentation";

/**
 * Live title and workflow state for a thread's linked issue. Rows share one
 * request per issue per environment, and the stored link carries the chip
 * until that request answers.
 */
export function useThreadIssue(thread: EnvironmentThreadShell): ThreadIssuePresentation | null {
  const link = thread.linkedIssue ?? null;
  const threadKey = scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id));
  const snapshotIdentity = JSON.stringify(link);
  // Select this row's entry so writes for other rows do not re-render it.
  const snapshotEntry = useAtomValue(
    threadIssueSnapshotsAtom,
    useCallback(
      (current: ReadonlyMap<string, ThreadIssueSnapshot>) => current.get(threadKey),
      [threadKey],
    ),
  );
  const snapshot = snapshotEntry?.identity === snapshotIdentity ? snapshotEntry.presentation : null;
  const issue = useEnvironmentQuery(
    link === null
      ? null
      : linearEnvironment.issue({
          environmentId: thread.environmentId,
          input: { reference: link.identifier },
        }),
  );

  const live = useMemo<ThreadIssuePresentation | null | undefined>(() => {
    if (link === null) return null;
    const detail = issue.data;
    return detail === null ? undefined : presentThreadIssue(detail);
  }, [link, issue.data]);

  useEffect(() => {
    if (live === undefined) return;
    appAtomRegistry.modify(threadIssueSnapshotsAtom, (current) => {
      const existing = current.get(threadKey);
      if (live === null) {
        if (existing === undefined) return [false, current];
        const next = new Map(current);
        next.delete(threadKey);
        return [true, next];
      }
      if (existing?.identity === snapshotIdentity && existing.presentation === live) {
        return [false, current];
      }
      const next = new Map(current);
      next.delete(threadKey);
      next.set(threadKey, { identity: snapshotIdentity, presentation: live });
      while (next.size > MAX_THREAD_ISSUE_SNAPSHOTS) {
        const oldestKey = next.keys().next().value;
        if (oldestKey === undefined) break;
        next.delete(oldestKey);
      }
      return [true, next];
    });
  }, [live, snapshotIdentity, threadKey]);

  return useMemo(
    () => resolveThreadIssuePresentation({ link, live, snapshot }),
    [link, live, snapshot],
  );
}
