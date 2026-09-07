import type {
  LinearIssueDetail,
  LinearWorkflowStateType,
  ThreadLinkedIssue,
} from "@t3tools/contracts";

/**
 * Everything the issue chip draws. A thread stores only the link, so the
 * fields Linear owns (title, state, colour) are absent until the issue query
 * answers; `stateName` empty means "not known yet", not "no state".
 */
export interface ThreadIssuePresentation {
  /** Linear's issue key, e.g. "DEL-123". */
  readonly identifier: string;
  readonly title: string;
  readonly stateName: string;
  readonly stateType: LinearWorkflowStateType | null;
  /** Hex colour of the workflow state, or null before the issue is loaded. */
  readonly color: string | null;
  readonly url: string;
  readonly accessibilityLabel: string;
}

export function presentThreadIssue(detail: LinearIssueDetail): ThreadIssuePresentation {
  return {
    identifier: detail.identifier,
    title: detail.title,
    stateName: detail.state.name,
    stateType: detail.state.type,
    color: detail.state.color,
    url: detail.url,
    accessibilityLabel: `${detail.identifier} ${detail.title}, ${detail.state.name}`,
  };
}

/**
 * The chip drawn from the stored link alone, so a linked thread shows its
 * issue the moment it renders instead of after a round trip.
 */
export function presentLinkedThreadIssue(link: ThreadLinkedIssue): ThreadIssuePresentation {
  return {
    identifier: link.identifier,
    title: "",
    stateName: "",
    stateType: null,
    color: null,
    url: link.url,
    accessibilityLabel: link.identifier,
  };
}

/**
 * What a row shows for one render: the live issue when it has arrived, else
 * the last presentation this row held, else the link on its own. Split out of
 * `useThreadIssue` so the fallback order is testable without a renderer.
 */
export function resolveThreadIssuePresentation(input: {
  readonly link: ThreadLinkedIssue | null;
  /** The presented live issue, or undefined while the query has no data. */
  readonly live: ThreadIssuePresentation | null | undefined;
  readonly snapshot: ThreadIssuePresentation | null;
}): ThreadIssuePresentation | null {
  if (input.link === null) return null;
  if (input.live !== undefined && input.live !== null) return input.live;
  return input.snapshot ?? presentLinkedThreadIssue(input.link);
}
