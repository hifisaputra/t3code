import type { EnvironmentId, LinearIssueDetail, LinearIssueRelative } from "@t3tools/contracts";
import { ExternalLinkIcon } from "lucide-react";
import type { MouseEvent, ReactNode } from "react";

import { linearEnvironment } from "~/state/linear";
import { useEnvironmentQuery } from "~/state/query";
import { formatRelativeTimeLabel } from "~/timestampFormat";

import ChatMarkdown from "../ChatMarkdown";
import { useOpenIssueLink } from "../ThreadStatusIndicators";
import { Button } from "../ui/button";
import { RefreshIcon } from "../ui/refresh-icon";
import { Spinner } from "../ui/spinner";
import { IssuesUnavailableState } from "./IssuesUnavailableState";
import { IssueStateDot } from "./IssueRow";
import { issueCycleLabel, type IssueLinkedThread } from "./issueList.logic";

/**
 * The selected issue, read live from Linear.
 *
 * Nothing here is stored: the list carries summaries, and this is the one extra
 * request the page makes — for the description, the comments and the issue's
 * relatives, which only matter for the row somebody is actually reading.
 */
export function IssueDetailPanel({
  environmentId,
  identifier,
  cwd,
  linkedThread,
  onStartThread,
  onOpenThread,
}: {
  environmentId: EnvironmentId;
  identifier: string;
  /** Anchors relative links in the markdown; null until a project is chosen. */
  cwd: string | null;
  linkedThread: IssueLinkedThread | null;
  onStartThread: (identifier: string) => void;
  onOpenThread: (thread: IssueLinkedThread) => void;
}) {
  const query = useEnvironmentQuery(
    linearEnvironment.issue({ environmentId, input: { reference: identifier } }),
  );
  const openIssueLink = useOpenIssueLink();
  const issue = query.data;

  if (issue === null && query.isPending) {
    return (
      <div className="flex items-center gap-2 p-6 text-muted-foreground text-xs">
        <Spinner className="size-3.5" />
        Loading {identifier}...
      </div>
    );
  }

  if (issue === null) {
    return (
      <IssuesUnavailableState
        title={`Could not load ${identifier}`}
        // The server's own sentence: "no issue DEL-9 in this workspace", a rate
        // limit, a rejected key. Guessing a friendlier one would say less.
        message={query.error ?? "Linear did not return this issue."}
        onRetry={query.refresh}
        refreshing={query.isPending}
      />
    );
  }

  return (
    <div className="flex min-h-0 flex-col gap-4 p-4">
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <a
            href={issue.url}
            onClick={(event) => openIssueLink(event, issue.url)}
            className="inline-flex items-center gap-1 font-mono text-muted-foreground text-xs underline-offset-2 hover:underline"
          >
            {issue.identifier}
            <ExternalLinkIcon aria-hidden className="size-3" />
          </a>
          <h2 className="mt-1 font-medium text-base text-foreground">{issue.title}</h2>
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          {linkedThread ? (
            <Button type="button" size="sm" onClick={() => onOpenThread(linkedThread)}>
              Open thread
            </Button>
          ) : (
            <Button type="button" size="sm" onClick={() => onStartThread(issue.identifier)}>
              Start thread
            </Button>
          )}
          <Button
            type="button"
            size="icon-sm"
            variant="ghost"
            aria-label="Refresh issue"
            onClick={query.refresh}
            disabled={query.isPending}
          >
            <RefreshIcon className="size-3.5" refreshing={query.isPending} />
          </Button>
        </div>
      </div>

      <dl className="grid grid-cols-[auto_minmax(0,1fr)] items-center gap-x-3 gap-y-1.5 text-xs">
        <IssueFact label="State">
          <span className="flex items-center gap-1.5">
            <IssueStateDot color={issue.state.color} className="size-2" />
            {issue.state.name}
          </span>
        </IssueFact>
        <IssueFact label="Assignee">
          {issue.assignee?.displayName ?? issue.assignee?.name ?? "Unassigned"}
        </IssueFact>
        <IssueFact label="Team">
          {issue.team.name} · {issue.team.key}
        </IssueFact>
        {issue.project ? <IssueFact label="Project">{issue.project.name}</IssueFact> : null}
        {issue.cycle ? <IssueFact label="Cycle">{issueCycleLabel(issue.cycle)}</IssueFact> : null}
      </dl>

      {issue.labels.length > 0 ? (
        <div className="flex flex-wrap items-center gap-1.5">
          {issue.labels.map((label) => (
            <span
              key={label.id}
              className="inline-flex items-center gap-1 rounded-full border border-border/70 bg-muted/40 py-0.5 pr-2 pl-1.5 text-[10px] text-muted-foreground"
            >
              <IssueStateDot color={label.color} className="size-1.5" />
              {label.name}
            </span>
          ))}
        </div>
      ) : null}

      {issue.parent ? (
        <IssueRelatives label="Parent" relatives={[issue.parent]} onOpen={openIssueLink} />
      ) : null}
      {issue.children.length > 0 ? (
        <IssueRelatives label="Sub-issues" relatives={issue.children} onOpen={openIssueLink} />
      ) : null}

      {issue.description && issue.description.trim().length > 0 ? (
        <ChatMarkdown
          text={issue.description}
          cwd={cwd ?? undefined}
          environmentId={environmentId}
          className="text-sm"
        />
      ) : (
        <p className="text-muted-foreground text-xs">No description.</p>
      )}

      {issue.comments.length > 0 ? (
        <div className="flex flex-col gap-3 border-border/60 border-t pt-3">
          <h3 className="font-medium text-foreground text-xs">
            {issue.comments.length === 1 ? "1 comment" : `${issue.comments.length} comments`}
          </h3>
          {issue.comments.map((entry) => (
            <IssueComment key={entry.id} comment={entry} cwd={cwd} environmentId={environmentId} />
          ))}
        </div>
      ) : null}
    </div>
  );
}

function IssueFact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <>
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="min-w-0 truncate text-foreground">{children}</dd>
    </>
  );
}

function IssueRelatives({
  label,
  relatives,
  onOpen,
}: {
  label: string;
  relatives: ReadonlyArray<LinearIssueRelative>;
  onOpen: (event: MouseEvent<HTMLElement>, url: string) => void;
}) {
  return (
    <div className="flex flex-col gap-1">
      <span className="font-medium text-foreground text-xs">{label}</span>
      {relatives.map((relative) => (
        <a
          key={relative.id}
          href={relative.url}
          onClick={(event) => onOpen(event, relative.url)}
          className="flex min-w-0 items-center gap-2 text-xs underline-offset-2 hover:underline"
        >
          <span className="shrink-0 font-mono text-muted-foreground">{relative.identifier}</span>
          <span className="min-w-0 flex-1 truncate">{relative.title}</span>
          <span className="shrink-0 text-muted-foreground">{relative.stateName}</span>
        </a>
      ))}
    </div>
  );
}

function IssueComment({
  comment,
  cwd,
  environmentId,
}: {
  comment: LinearIssueDetail["comments"][number];
  cwd: string | null;
  environmentId: EnvironmentId;
}) {
  return (
    <div className="flex flex-col gap-1">
      <span className="flex items-center gap-2 text-muted-foreground text-xs">
        <span className="font-medium text-foreground">
          {comment.author?.displayName ?? comment.author?.name ?? "Unknown"}
        </span>
        {formatRelativeTimeLabel(comment.createdAt)}
      </span>
      <ChatMarkdown
        text={comment.body}
        cwd={cwd ?? undefined}
        environmentId={environmentId}
        className="text-sm"
      />
    </div>
  );
}
