import {
  assistantTaskReports,
  type AssistantBoard,
  type AssistantTaskSummary,
  type EnvironmentId,
  type ThreadId,
} from "@t3tools/contracts";
import {
  ArrowLeftIcon,
  CheckIcon,
  ChevronRightIcon,
  ExternalLinkIcon,
  UndoIcon,
} from "lucide-react";
import { useState } from "react";

import { cn } from "~/lib/utils";
import { developerAssistant } from "~/state/developerAssistant";
import { useAtomCommand } from "~/state/use-atom-command";
import { formatRelativeTimeLabel } from "~/timestampFormat";

import { Button } from "../ui/button";
import { Skeleton } from "../ui/skeleton";
import { Spinner } from "../ui/spinner";
import { Textarea } from "../ui/textarea";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import {
  CriteriaResults,
  EvidenceHeading,
  EvidenceNotes,
  HumanChecklist,
  RecordingList,
  ResearchEvidence,
  ScreenshotGrid,
  useEvidenceViewer,
} from "./AssistantReviewEvidence";
import { reportWords } from "./assistantBoard.logic";
import { TeamThreads } from "./AssistantTeam";
import {
  CommitChip,
  ExpandableMarkdown,
  IssueLink,
  StatusDot,
  useAssistantAction,
  type StatusTone,
} from "./assistantUi";
import { reviewOutcomeLine, reviewSummary, type ReviewVerdictTone } from "./reviewCard.logic";
import { TrackBadge } from "./threadKinds";
import { useAssistantTaskDetail } from "./useAssistantTaskDetail";

const VERDICT_TONE: Record<ReviewVerdictTone, { dot: StatusTone; text: string }> = {
  passed: { dot: "active", text: "text-success-foreground" },
  verified: { dot: "active", text: "text-success-foreground" },
  partial: { dot: "attention", text: "text-warning-foreground" },
  failed: { dot: "blocked", text: "text-destructive-foreground" },
};

/** The other issues waiting to be accepted, so a person can work through them in one sitting. */
function ReviewQueue({
  reviews,
  current,
  onSelect,
}: {
  reviews: ReadonlyArray<AssistantTaskSummary>;
  current: string;
  onSelect: (taskId: string) => void;
}) {
  return (
    <nav
      aria-label="Waiting for you"
      className="hidden w-64 shrink-0 flex-col border-border border-r lg:flex"
    >
      <p className="px-3 pt-4 pb-2 font-medium text-muted-foreground text-xs uppercase tracking-wide">
        Waiting for you · {reviews.length}
      </p>
      <ul className="min-h-0 flex-1 overflow-y-auto px-2 pb-4">
        {reviews.map((task) => {
          const summary = reviewSummary(task);
          const selected = task.id === current;
          return (
            <li key={task.id}>
              <button
                type="button"
                aria-current={selected ? "true" : undefined}
                onClick={() => onSelect(task.id)}
                className={cn(
                  "flex w-full min-w-0 flex-col gap-0.5 rounded-lg px-2.5 py-2 text-left transition-colors",
                  selected ? "bg-accent" : "hover:bg-accent/50",
                )}
              >
                <span className="flex min-w-0 items-center gap-1.5 text-xs">
                  <StatusDot tone={VERDICT_TONE[summary.verdict.tone].dot} />
                  <span className="shrink-0 font-mono text-muted-foreground">
                    {task.issue.identifier}
                  </span>
                  <span className="ml-auto shrink-0 text-muted-foreground/80">
                    {formatRelativeTimeLabel(task.updatedAt)}
                  </span>
                </span>
                <span className={cn("line-clamp-2 text-sm", selected && "font-medium")}>
                  {task.issue.title}
                </span>
                <span className="truncate text-muted-foreground text-xs">
                  {summary.humanChecks > 0
                    ? `${summary.humanChecks} check${summary.humanChecks === 1 ? "" : "s"} for you`
                    : summary.verdict.label}
                </span>
              </button>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}

/** A section of the read-through, each one a heading and its content. */
function Part({
  title,
  count,
  children,
}: {
  title: string;
  count?: number;
  children: React.ReactNode;
}) {
  return (
    <section className="flex flex-col">
      <EvidenceHeading count={count}>{title}</EvidenceHeading>
      {children}
    </section>
  );
}

/**
 * One finished issue, read end to end: what changed, what the tester checked
 * and showed, what is left for the person, and the two ways to answer it.
 *
 * This is the only place evidence is mounted. A person reads one issue at a
 * time, so one issue's screenshots and recordings are all that is ever
 * fetched, however many are waiting.
 */
export function AssistantReviewView({
  environmentId,
  board,
  task,
  reviews,
  projectLabel,
  acceptedState,
  onSelect,
  onBack,
  onOpenThread,
}: {
  environmentId: EnvironmentId;
  board: AssistantBoard;
  task: AssistantTaskSummary;
  /** Every issue waiting to be accepted, this one among them. */
  reviews: ReadonlyArray<AssistantTaskSummary>;
  projectLabel: string | null;
  acceptedState: string;
  onSelect: (taskId: string) => void;
  onBack: () => void;
  onOpenThread: (threadId: ThreadId) => void;
}) {
  const review = useAtomCommand(developerAssistant.review);
  const { pending, run } = useAssistantAction();
  const [requesting, setRequesting] = useState(false);
  const [feedback, setFeedback] = useState("");
  const [ticked, setTicked] = useState<ReadonlySet<number>>(() => new Set());
  const detail = useAssistantTaskDetail(environmentId, task);
  // The row's own summary until the rest arrives, so the page never blinks empty.
  const opened = detail.task ?? task;
  const viewer = useEvidenceViewer(environmentId, detail.task);
  const summary = reviewSummary(task);
  const tone = VERDICT_TONE[summary.verdict.tone];
  const e2e = opened.e2e ?? null;
  const humanChecks = e2e?.humanChecks ?? [];
  const position = reviews.findIndex((entry) => entry.id === task.id);
  const next = reviews[position + 1] ?? reviews[position - 1] ?? null;

  const submit = (action: "accept" | "request-changes") =>
    run(
      action,
      () =>
        review({
          environmentId,
          input: { taskId: task.id, action, feedback: action === "accept" ? "" : feedback.trim() },
        }),
      {
        failure: action === "accept" ? "Could not accept the work" : "Could not send it back",
        success:
          action === "accept"
            ? `${task.issue.identifier} accepted`
            : `${task.issue.identifier} sent back for changes`,
      },
      // Answering one issue moves to the next, so a queue can be worked through
      // without going back to the board between each.
    ).then((done) => {
      if (done) {
        setRequesting(false);
        setFeedback("");
        if (next) onSelect(next.id);
        else onBack();
      }
    });

  return (
    <div className="flex min-h-0 flex-1">
      {reviews.length > 1 ? (
        <ReviewQueue reviews={reviews} current={task.id} onSelect={onSelect} />
      ) : null}
      <div className="flex min-w-0 min-h-0 flex-1 flex-col">
        <header className="flex flex-col gap-2 border-border border-b px-4 py-3 sm:px-6">
          <div className="flex min-w-0 items-center gap-2 text-xs">
            <Button size="xs" variant="ghost" onClick={onBack}>
              <ArrowLeftIcon />
              Board
            </Button>
            <span className="shrink-0 font-mono text-muted-foreground">
              {task.issue.identifier}
            </span>
            <TrackBadge track={task.track} />
            {projectLabel ? (
              <span className="min-w-0 truncate text-muted-foreground">{projectLabel}</span>
            ) : null}
            <span className="ml-auto shrink-0 text-muted-foreground/80">
              {formatRelativeTimeLabel(task.deployment?.verifiedAt ?? task.updatedAt)}
            </span>
          </div>
          <h1 className="font-semibold text-base leading-snug">{task.issue.title}</h1>
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 text-xs">
            <span className={cn("inline-flex items-center gap-1.5 font-medium", tone.text)}>
              <StatusDot tone={tone.dot} />
              {summary.verdict.label}
            </span>
            {summary.criteria ? (
              <span className="text-muted-foreground">{summary.criteria.label}</span>
            ) : null}
            {summary.engineering ? (
              summary.engineering.detail ? (
                <Tooltip>
                  <TooltipTrigger
                    render={
                      <span className="cursor-default text-muted-foreground underline decoration-dotted underline-offset-2" />
                    }
                  >
                    {summary.engineering.label}
                  </TooltipTrigger>
                  <TooltipPopup className="max-w-80 whitespace-pre-line">
                    {summary.engineering.detail}
                  </TooltipPopup>
                </Tooltip>
              ) : (
                <span className="text-muted-foreground">{summary.engineering.label}</span>
              )
            ) : null}
            {!assistantTaskReports(task) && task.deployment ? (
              <CommitChip revision={task.deployment.revision} />
            ) : null}
            <span className="ml-auto flex items-center gap-3">
              {!assistantTaskReports(task) && task.deployment ? (
                <Button
                  size="xs"
                  variant="outline"
                  render={<a href={task.deployment.url} target="_blank" rel="noreferrer" />}
                >
                  <ExternalLinkIcon />
                  Open staging
                </Button>
              ) : null}
              <IssueLink issue={task.issue} />
            </span>
          </div>
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto">
          <div className="mx-auto flex w-full max-w-3xl flex-col gap-6 px-4 py-5 sm:px-6">
            {detail.error ? (
              <p className="rounded-lg bg-warning/8 px-3 py-2 text-warning-foreground text-sm">
                Could not load the rest of this issue: {detail.error}
              </p>
            ) : null}
            {assistantTaskReports(task) ? (
              <ResearchEvidence task={opened} environmentId={environmentId} viewer={viewer} />
            ) : (
              <>
                {detail.isPending && opened.summary === undefined ? (
                  <div className="flex flex-col gap-2">
                    <Skeleton className="h-4 w-24" />
                    <Skeleton className="h-16" />
                  </div>
                ) : opened.summary?.trim() ? (
                  <Part title="What changed">
                    <ExpandableMarkdown
                      text={opened.summary}
                      environmentId={environmentId}
                      collapsedClassName="max-h-40"
                    />
                  </Part>
                ) : null}

                {humanChecks.length > 0 ? (
                  <Part title="Check before accepting" count={humanChecks.length}>
                    <HumanChecklist
                      checks={humanChecks}
                      ticked={ticked}
                      onTick={(index, checked) =>
                        setTicked((current) => {
                          const next = new Set(current);
                          if (checked) next.add(index);
                          else next.delete(index);
                          return next;
                        })
                      }
                    />
                  </Part>
                ) : null}

                {opened.criteria?.length || e2e?.checks?.length ? (
                  <Part title={e2e ? "What the tester checked" : "Acceptance criteria"}>
                    <CriteriaResults task={opened} viewer={viewer} />
                  </Part>
                ) : null}

                {viewer.shots.length > 0 ? (
                  <Part title="Screenshots" count={viewer.shots.length}>
                    <ScreenshotGrid viewer={viewer} />
                  </Part>
                ) : null}

                {viewer.videos.length > 0 ? (
                  <Part title="Recordings" count={viewer.videos.length}>
                    <RecordingList viewer={viewer} />
                  </Part>
                ) : null}

                {e2e?.worthALook?.length ? (
                  <Part title="Worth a look">
                    <EvidenceNotes items={e2e.worthALook} />
                  </Part>
                ) : null}

                {opened.reviewInstructions?.trim() ? (
                  <div className="rounded-lg bg-muted/50 px-3 py-2.5">
                    <EvidenceHeading>{e2e ? "Staging check" : "How to check it"}</EvidenceHeading>
                    <ExpandableMarkdown
                      text={opened.reviewInstructions}
                      environmentId={environmentId}
                      collapsedClassName="max-h-32"
                    />
                  </div>
                ) : null}
              </>
            )}
            {task.error ? (
              <p className="rounded-lg bg-warning/8 px-3 py-2 text-warning-foreground text-xs">
                {task.error}
              </p>
            ) : null}
            <TeamThreads
              label="Team"
              size="sm"
              environmentId={environmentId}
              task={task}
              board={board}
              onOpenThread={onOpenThread}
            />
          </div>
        </div>

        <footer className="border-border border-t bg-background px-4 py-3 sm:px-6">
          {requesting ? (
            <form
              className="mx-auto flex w-full max-w-3xl flex-col gap-2"
              onSubmit={(event) => {
                event.preventDefault();
                if (feedback.trim()) void submit("request-changes");
              }}
            >
              <Textarea
                size="sm"
                autoFocus
                aria-label={`Changes you want in ${task.issue.identifier}`}
                placeholder={
                  assistantTaskReports(task)
                    ? reportWords(task.track).sendBack
                    : task.track === "test"
                      ? "What should the team test again?"
                      : "What should change? A fresh worker starts from the current integration branch."
                }
                value={feedback}
                onChange={(event) => setFeedback(event.target.value)}
                onKeyDown={(event) => {
                  if (
                    event.key === "Enter" &&
                    (event.metaKey || event.ctrlKey) &&
                    feedback.trim()
                  ) {
                    event.preventDefault();
                    void submit("request-changes");
                  }
                }}
                className="[&_textarea]:min-h-16"
              />
              <div className="flex justify-end gap-2">
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  onClick={() => setRequesting(false)}
                >
                  Cancel
                </Button>
                <Button type="submit" size="sm" disabled={!feedback.trim() || pending !== null}>
                  {pending === "request-changes" ? <Spinner className="size-3.5" /> : <UndoIcon />}
                  Send back
                </Button>
              </div>
            </form>
          ) : (
            <div className="mx-auto flex w-full max-w-3xl flex-wrap items-center gap-2">
              <Button size="sm" disabled={pending !== null} onClick={() => void submit("accept")}>
                {pending === "accept" ? <Spinner className="size-3.5" /> : <CheckIcon />}
                Accept
              </Button>
              <Button
                size="sm"
                variant="outline"
                disabled={pending !== null}
                onClick={() => setRequesting(true)}
              >
                <UndoIcon />
                Request changes
              </Button>
              <span className="text-muted-foreground text-xs">
                {reviewOutcomeLine(summary)}
                {" · "}
                Accepting moves the issue to {acceptedState}
              </span>
              {next ? (
                <Button
                  size="sm"
                  variant="ghost"
                  className="ml-auto"
                  onClick={() => onSelect(next.id)}
                >
                  Next issue
                  <ChevronRightIcon />
                </Button>
              ) : null}
            </div>
          )}
        </footer>
      </div>
      {viewer.dialog}
    </div>
  );
}
