import {
  assistantThreadKind,
  type AssistantDecision,
  type AssistantProject,
  type AssistantSetup,
  type AssistantTask,
  type EnvironmentId,
  type ThreadId,
} from "@t3tools/contracts";
import {
  ArrowUpRightIcon,
  CheckIcon,
  ChevronDownIcon,
  ExternalLinkIcon,
  MessageCircleQuestionIcon,
  OctagonAlertIcon,
  PauseCircleIcon,
  PlayIcon,
  RotateCcwIcon,
  SendHorizontalIcon,
  ShieldQuestionIcon,
  SkipForwardIcon,
  SparklesIcon,
  UndoIcon,
} from "lucide-react";
import { useState, type ReactNode } from "react";

import { cn, isMacPlatform } from "~/lib/utils";
import { developerAssistant } from "~/state/developerAssistant";
import { useAtomCommand } from "~/state/use-atom-command";
import { formatRelativeTimeLabel } from "~/timestampFormat";

import { Button } from "../ui/button";
import { Kbd } from "../ui/kbd";
import { Spinner } from "../ui/spinner";
import { Textarea } from "../ui/textarea";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { decisionOptions, previewLine, type InboxItem } from "./assistantBoard.logic";
import {
  CriteriaResults,
  EvidenceHeading,
  EvidenceNotes,
  HumanChecklist,
  RecordingList,
  ScreenshotGrid,
  useScreenshotViewer,
} from "./AssistantReviewEvidence";
import { TeamThreads } from "./AssistantTeam";
import {
  CommitChip,
  confirmDestructive,
  ExpandableMarkdown,
  IssueLink,
  StatusDot,
  useAssistantAction,
  type StatusTone,
} from "./assistantUi";
import { reviewOutcomeLine, reviewSummary, type ReviewVerdictTone } from "./reviewCard.logic";
import { THREAD_KIND } from "./threadKinds";

type Accent = "question" | "review" | "blocked" | "paused" | "setup";

const ACCENT: Record<Accent, { icon: typeof CheckIcon; tint: string }> = {
  question: { icon: MessageCircleQuestionIcon, tint: "bg-info/10 text-info-foreground" },
  review: { icon: CheckIcon, tint: "bg-success/10 text-success-foreground" },
  blocked: { icon: OctagonAlertIcon, tint: "bg-destructive/10 text-destructive-foreground" },
  paused: { icon: PauseCircleIcon, tint: "bg-warning/12 text-warning-foreground" },
  setup: { icon: SparklesIcon, tint: "bg-info/10 text-info-foreground" },
};

/**
 * One thing waiting on the person, as a two-line row that opens in place.
 * Agent text is long; the row says what it is and who is asking, and the
 * detail and the controls to act on it are one click away. `actions` sit on
 * the collapsed row outside the toggle, so clicking them never opens it.
 */
function InboxRow({
  id,
  accent,
  kind,
  context,
  summary,
  detail,
  at,
  expanded,
  onToggle,
  actions,
  links,
  children,
}: {
  id: string;
  accent: Accent;
  kind: ReactNode;
  context?: ReactNode;
  summary: ReactNode;
  /** A muted line under the summary. */
  detail?: ReactNode;
  at?: string | null;
  expanded: boolean;
  onToggle: () => void;
  actions?: ReactNode;
  links?: ReactNode;
  children: ReactNode;
}) {
  const { icon: Icon, tint } = ACCENT[accent];
  return (
    <article
      id={id}
      className={cn(
        "scroll-mt-4 rounded-xl border bg-card shadow-xs/5 transition-colors",
        expanded ? "border-border" : "border-border/70",
      )}
    >
      {/* The toggle's ::after covers the whole header, so the row is one click
          target while the actions, raised above it, stay separate buttons. */}
      <div className="relative flex min-w-0 items-start gap-3 rounded-xl px-4 py-3 hover:bg-accent/40 has-[>button:focus-visible]:ring-1 has-[>button:focus-visible]:ring-ring">
        <span
          className={cn("mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-md", tint)}
        >
          <Icon aria-hidden className="size-3.5" />
        </span>
        <button
          type="button"
          aria-expanded={expanded}
          onClick={onToggle}
          className="block min-w-0 flex-1 text-left after:absolute after:inset-0 after:rounded-xl focus-visible:outline-none"
        >
          <span className="flex min-w-0 items-center gap-1.5 text-xs">
            <span className="flex shrink-0 items-center gap-1 font-medium text-foreground">
              {kind}
            </span>
            {context ? (
              <span className="flex min-w-0 items-center gap-1.5 text-muted-foreground">
                <span aria-hidden>·</span>
                {context}
              </span>
            ) : null}
            {at ? (
              <span className="ml-auto shrink-0 pl-2 text-muted-foreground/80 tabular-nums">
                {formatRelativeTimeLabel(at)}
              </span>
            ) : null}
          </span>
          <span
            className={cn(
              "mt-0.5 block text-sm leading-snug",
              expanded ? "font-medium" : "line-clamp-2",
            )}
          >
            {summary}
          </span>
          {detail ? (
            <span className="mt-0.5 block truncate text-muted-foreground text-xs">{detail}</span>
          ) : null}
        </button>
        {actions ? (
          <div className="relative z-10 flex shrink-0 items-center gap-1.5 self-center">
            {actions}
          </div>
        ) : null}
        <ChevronDownIcon
          aria-hidden
          className={cn(
            "mt-1 size-4 shrink-0 text-muted-foreground transition-transform",
            expanded && "rotate-180",
          )}
        />
      </div>
      {expanded ? (
        <div className="flex flex-col gap-3 border-border/60 border-t px-4 pt-3 pb-4">
          {links ? (
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">{links}</div>
          ) : null}
          {children}
        </div>
      ) : null}
    </article>
  );
}

/** Where the detail lives: the issue in Linear, and the thread it came from. */
function RowLinks({
  issue,
  thread,
  threadLabel,
  onOpenThread,
}: {
  issue?: AssistantTask["issue"] | undefined;
  thread?: ThreadId;
  threadLabel?: string;
  onOpenThread: (threadId: ThreadId) => void;
}) {
  return (
    <>
      {issue ? <IssueLink issue={issue} /> : null}
      {thread ? (
        <button
          type="button"
          onClick={() => onOpenThread(thread)}
          className="inline-flex items-center gap-1 text-muted-foreground hover:text-foreground hover:underline"
        >
          {threadLabel ?? "Open thread"}
          <ArrowUpRightIcon aria-hidden className="size-3" />
        </button>
      ) : null}
    </>
  );
}

function IssueContext({
  project,
  issue,
}: {
  project: string | null;
  issue?: AssistantTask["issue"] | undefined;
}) {
  return (
    <>
      {issue ? (
        <>
          <span className="shrink-0 font-mono">{issue.identifier}</span>
          <span className="min-w-0 truncate">{issue.title}</span>
        </>
      ) : null}
      {project ? <span className="min-w-0 truncate">{project}</span> : null}
    </>
  );
}

export interface InboxContext {
  environmentId: EnvironmentId;
  /** Project names, shown only when more than one project could be meant. */
  projectLabel: (projectId: AssistantProject["config"]["projectId"]) => string | null;
  projectTitle: (projectId: AssistantProject["config"]["projectId"]) => string;
  tasks: ReadonlyArray<AssistantTask>;
  projects: ReadonlyArray<AssistantProject>;
  onOpenThread: (threadId: ThreadId) => void;
  onReviewSetup: (setup: AssistantSetup) => void;
  isExpanded: (key: string) => boolean;
  onToggle: (key: string) => void;
}

export const inboxElementId = (key: string) => `assistant-inbox-${key.replace(/[^\w-]/g, "-")}`;

export function InboxItemCard({ item, context }: { item: InboxItem; context: InboxContext }) {
  const row = {
    id: inboxElementId(item.key),
    expanded: context.isExpanded(item.key),
    onToggle: () => context.onToggle(item.key),
  };
  switch (item.kind) {
    case "decision":
      return <DecisionCard decision={item.decision} context={context} row={row} />;
    case "review":
      return <ReviewCard task={item.task} context={context} row={row} />;
    case "stuck":
      return <StuckTaskCard task={item.task} reason={item.reason} context={context} row={row} />;
    case "paused":
      return (
        <PausedProjectCard
          project={item.project}
          reason={item.reason}
          context={context}
          row={row}
        />
      );
    case "setup":
      return <SetupReadyCard setup={item.setup} context={context} row={row} />;
  }
}

type RowState = { id: string; expanded: boolean; onToggle: () => void };

function DecisionCard({
  decision,
  context,
  row,
}: {
  decision: AssistantDecision;
  context: InboxContext;
  row: RowState;
}) {
  const answer = useAtomCommand(developerAssistant.answer);
  const { pending, run } = useAssistantAction();
  const [draft, setDraft] = useState("");
  const task = decision.taskId ? context.tasks.find((t) => t.id === decision.taskId) : undefined;
  const options = decision.kind === "decision" ? decisionOptions(decision.question) : [];
  const asker = THREAD_KIND[assistantThreadKind(decision.threadId) ?? "implement"];
  const askedBy = (
    <>
      <asker.icon aria-hidden className={cn("size-3.5", asker.className)} />
      {asker.label}
    </>
  );
  const issueContext = (
    <IssueContext project={context.projectLabel(decision.projectId)} issue={task?.issue} />
  );
  const send = () => {
    const text = draft.trim();
    if (!text || pending) return;
    void run(
      "answer",
      () =>
        answer({
          environmentId: context.environmentId,
          input: { decisionId: decision.id, answer: text },
        }),
      { failure: "Could not send your answer" },
    ).then((sent) => {
      if (sent) setDraft("");
    });
  };

  if (decision.kind !== "decision") {
    const approval = decision.kind === "approval";
    return (
      <InboxRow
        {...row}
        accent="question"
        kind={
          <>
            {askedBy}
            {approval ? " needs permission" : " asks in its thread"}
          </>
        }
        context={issueContext}
        summary={decision.question}
        at={decision.createdAt}
      >
        <p className="flex items-start gap-2 text-sm">
          <ShieldQuestionIcon
            aria-hidden
            className="mt-0.5 size-4 shrink-0 text-muted-foreground"
          />
          <span className="min-w-0 whitespace-pre-wrap">{decision.question}</span>
        </p>
        <div className="flex flex-wrap items-center gap-2">
          <Button size="sm" onClick={() => context.onOpenThread(decision.threadId)}>
            <ArrowUpRightIcon />
            {approval ? "Review in thread" : "Answer in thread"}
          </Button>
          <span className="text-muted-foreground text-xs">
            The assistant never answers these for you.
          </span>
        </div>
      </InboxRow>
    );
  }

  return (
    <InboxRow
      {...row}
      accent="question"
      kind={<>{askedBy} asks</>}
      context={issueContext}
      summary={previewLine(decision.question)}
      at={decision.createdAt}
      links={
        <RowLinks
          issue={task?.issue}
          thread={decision.threadId}
          threadLabel={`Open ${asker.label.toLowerCase()} thread`}
          onOpenThread={context.onOpenThread}
        />
      }
    >
      <ExpandableMarkdown text={decision.question} environmentId={context.environmentId} />
      <form
        className="flex flex-col gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          send();
        }}
      >
        {options.length > 0 ? (
          <div className="flex flex-wrap gap-1.5" role="group" aria-label="Suggested answers">
            {options.map((option) => (
              <button
                key={option.number}
                type="button"
                onClick={() => setDraft(`Go with option ${option.number}. `)}
                className={cn(
                  "inline-flex max-w-full items-center gap-1.5 rounded-full border px-2.5 py-1 text-left text-xs transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
                  option.recommended ? "border-info/40 bg-info/6" : "border-border/70",
                )}
              >
                <span className="font-medium tabular-nums">{option.number}</span>
                <span className="min-w-0 truncate">{option.label}</span>
                {option.recommended ? (
                  <span className="shrink-0 font-medium text-[10px] text-info-foreground uppercase tracking-wide">
                    Suggested
                  </span>
                ) : null}
              </button>
            ))}
          </div>
        ) : null}
        <Textarea
          size="sm"
          aria-label="Your answer"
          placeholder="Write your answer…"
          value={draft}
          disabled={pending !== null}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
              event.preventDefault();
              send();
            }
          }}
          className="[&_textarea]:max-h-48 [&_textarea]:min-h-14"
        />
        <div className="flex flex-wrap items-center gap-2">
          <span className="min-w-0 flex-1 text-muted-foreground text-xs">
            Replying in the thread works too.
          </span>
          <Button type="submit" size="sm" disabled={!draft.trim() || pending !== null}>
            {pending ? <Spinner className="size-3.5" /> : <SendHorizontalIcon />}
            Send answer
            <Kbd className="ml-0.5 hidden sm:inline-flex">
              {isMacPlatform(navigator.platform) ? "⌘↵" : "Ctrl ↵"}
            </Kbd>
          </Button>
        </div>
      </form>
    </InboxRow>
  );
}

const VERDICT_TONE: Record<ReviewVerdictTone, { dot: StatusTone; text: string }> = {
  passed: { dot: "active", text: "text-success-foreground" },
  verified: { dot: "active", text: "text-success-foreground" },
  partial: { dot: "attention", text: "text-warning-foreground" },
  failed: { dot: "blocked", text: "text-destructive-foreground" },
};

/**
 * Finished work waiting for the person to accept it: what changed, what the
 * tester checked and showed, and what is left for the person to check. Work
 * with nothing left to check can be accepted from the collapsed row.
 */
function ReviewCard({
  task,
  context,
  row,
}: {
  task: AssistantTask;
  context: InboxContext;
  row: RowState;
}) {
  const review = useAtomCommand(developerAssistant.review);
  const { pending, run } = useAssistantAction();
  const [requesting, setRequesting] = useState(false);
  const [feedback, setFeedback] = useState("");
  // Ticks live here, not in the body, so collapsing the card keeps them.
  const [ticked, setTicked] = useState<ReadonlySet<number>>(() => new Set());
  const viewer = useScreenshotViewer(context.environmentId, task);
  const summary = reviewSummary(task);
  // The page keeps one set of toggled keys, closed by default. A card worth
  // opening at once reads membership inverted, so it starts open and the
  // person's first click closes it.
  const expanded = summary.startsOpen ? !row.expanded : row.expanded;
  const e2e = task.e2e ?? null;
  const acceptedState =
    context.projects.find((p) => p.config.projectId === task.projectId)?.config.acceptedState ??
    "done";
  const tone = VERDICT_TONE[summary.verdict.tone];
  const submit = (action: "accept" | "request-changes") =>
    run(
      action,
      () =>
        review({
          environmentId: context.environmentId,
          input: { taskId: task.id, action, feedback: action === "accept" ? "" : feedback.trim() },
        }),
      {
        failure: action === "accept" ? "Could not accept the work" : "Could not send it back",
        success:
          action === "accept"
            ? `${task.issue.identifier} accepted`
            : `${task.issue.identifier} sent back for changes`,
      },
    );
  const acceptButton = (size: "xs" | "sm") => (
    <Button
      size={size}
      variant={size === "xs" ? "outline" : "default"}
      disabled={pending !== null}
      onClick={() => void submit("accept")}
    >
      {pending === "accept" ? <Spinner className="size-3.5" /> : <CheckIcon />}
      Accept
    </Button>
  );
  const stagingButton = task.deployment ? (
    <Button
      size="xs"
      variant="outline"
      render={<a href={task.deployment.url} target="_blank" rel="noreferrer" />}
    >
      <ExternalLinkIcon />
      Open staging
    </Button>
  ) : null;
  const humanChecks = e2e?.humanChecks ?? [];

  return (
    <InboxRow
      {...row}
      expanded={expanded}
      accent="review"
      kind={summary.kind}
      context={
        <>
          <span className="shrink-0 font-mono">{task.issue.identifier}</span>
          {context.projectLabel(task.projectId) ? (
            <span className="min-w-0 truncate">{context.projectLabel(task.projectId)}</span>
          ) : null}
        </>
      }
      summary={<span className="font-medium">{task.issue.title}</span>}
      detail={expanded ? null : reviewOutcomeLine(summary)}
      at={task.deployment?.verifiedAt ?? task.updatedAt}
      actions={
        !expanded && summary.nothingToCheck ? (
          <>
            {stagingButton}
            {acceptButton("xs")}
          </>
        ) : null
      }
    >
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 rounded-lg bg-muted/50 px-3 py-2 text-xs">
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
        {task.deployment ? <CommitChip revision={task.deployment.revision} /> : null}
        {task.deployment?.evidence?.map((entry) => (
          <span
            key={entry.targetId}
            className="inline-flex items-center gap-1 text-muted-foreground"
          >
            <CheckIcon aria-hidden className="size-3 text-success-foreground" />
            {entry.targetId} deployed
          </span>
        ))}
        <span className="ml-auto flex items-center gap-3">
          {stagingButton}
          <IssueLink issue={task.issue} />
        </span>
      </div>
      {task.summary.trim() ? (
        <ExpandableMarkdown
          text={task.summary}
          environmentId={context.environmentId}
          collapsedClassName="max-h-28"
        />
      ) : null}
      {humanChecks.length > 0 ? (
        <section>
          <EvidenceHeading count={`${ticked.size} of ${humanChecks.length}`}>
            Check before accepting
          </EvidenceHeading>
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
        </section>
      ) : null}
      {task.criteria?.length || e2e?.checks?.length ? (
        <section>
          <EvidenceHeading>
            {e2e ? "What the tester checked" : "Acceptance criteria"}
          </EvidenceHeading>
          <CriteriaResults task={task} viewer={viewer} />
        </section>
      ) : null}
      {viewer.shots.length > 0 ? (
        <section>
          <EvidenceHeading count={viewer.shots.length}>Screenshots</EvidenceHeading>
          <ScreenshotGrid viewer={viewer} />
        </section>
      ) : null}
      {viewer.videos.length > 0 ? (
        <section>
          <EvidenceHeading count={viewer.videos.length}>Recordings</EvidenceHeading>
          <RecordingList viewer={viewer} />
        </section>
      ) : null}
      {e2e?.worthALook?.length ? (
        <section>
          <EvidenceHeading>Worth a look</EvidenceHeading>
          <EvidenceNotes items={e2e.worthALook} />
        </section>
      ) : null}
      {task.reviewInstructions.trim() ? (
        <div className="rounded-lg bg-muted/50 px-3 py-2.5">
          <EvidenceHeading>{e2e ? "Staging check" : "How to check it"}</EvidenceHeading>
          <ExpandableMarkdown
            text={task.reviewInstructions}
            environmentId={context.environmentId}
            collapsedClassName="max-h-32"
          />
        </div>
      ) : null}
      {task.error ? (
        <p className="rounded-lg bg-warning/8 px-3 py-2 text-warning-foreground text-xs">
          {task.error}
        </p>
      ) : null}
      {requesting ? (
        <form
          className="flex flex-col gap-2 border-border/60 border-t pt-3"
          onSubmit={(event) => {
            event.preventDefault();
            if (feedback.trim()) void submit("request-changes");
          }}
        >
          <Textarea
            size="sm"
            autoFocus
            aria-label={`Changes you want in ${task.issue.identifier}`}
            placeholder="What should change? A fresh worker starts from the current integration branch."
            value={feedback}
            onChange={(event) => setFeedback(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && (event.metaKey || event.ctrlKey) && feedback.trim()) {
                event.preventDefault();
                void submit("request-changes");
              }
            }}
            className="[&_textarea]:min-h-16"
          />
          <div className="flex justify-end gap-2">
            <Button type="button" size="sm" variant="ghost" onClick={() => setRequesting(false)}>
              Cancel
            </Button>
            <Button type="submit" size="sm" disabled={!feedback.trim() || pending !== null}>
              {pending === "request-changes" ? <Spinner className="size-3.5" /> : <UndoIcon />}
              Send back
            </Button>
          </div>
        </form>
      ) : null}
      <div className="flex flex-wrap items-center gap-x-2 gap-y-2 border-border/60 border-t pt-3">
        {requesting ? null : (
          <>
            {acceptButton("sm")}
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
              Accepting moves the issue to {acceptedState}
            </span>
          </>
        )}
        <div className="ml-auto">
          <TeamThreads
            label="Team"
            size="sm"
            environmentId={context.environmentId}
            task={task}
            onOpenThread={context.onOpenThread}
          />
        </div>
      </div>
      {viewer.dialog}
    </InboxRow>
  );
}

function StuckTaskCard({
  task,
  reason,
  context,
  row,
}: {
  task: AssistantTask;
  reason: "rounds" | "stopped";
  context: InboxContext;
  row: RowState;
}) {
  const review = useAtomCommand(developerAssistant.review);
  const control = useAtomCommand(developerAssistant.control);
  const { pending, run } = useAssistantAction();
  const project = context.projects.find((p) => p.config.projectId === task.projectId);
  const moreRounds = project?.config.maxWorkerTurns ?? 6;
  const skip = async () => {
    const confirmed = await confirmDestructive(
      `Skip ${task.issue.identifier}?\nQueued work is cancelled and the project moves on. The thread and branch stay for you to inspect. A merge, deployment, migration or Linear state already made is not undone.`,
    );
    if (!confirmed) return;
    void run(
      "skip",
      () =>
        review({
          environmentId: context.environmentId,
          input: { taskId: task.id, action: "skip", feedback: "Skipped from the assistant board." },
        }),
      { failure: "Could not skip the issue", success: `${task.issue.identifier} skipped` },
    );
  };
  return (
    <InboxRow
      {...row}
      accent="blocked"
      kind={reason === "rounds" ? "Out of work rounds" : "Stuck while stopped"}
      context={<IssueContext project={context.projectLabel(task.projectId)} issue={task.issue} />}
      summary={
        reason === "rounds"
          ? `The worker used all ${task.turnLimit} rounds without finishing.`
          : "The assistant is stopped with this issue unfinished."
      }
      at={task.updatedAt}
      links={
        <RowLinks
          issue={task.issue}
          thread={task.threadId}
          threadLabel="Open worker thread"
          onOpenThread={context.onOpenThread}
        />
      }
    >
      <p className="text-muted-foreground text-sm">
        {reason === "rounds"
          ? "Give it more rounds, or skip the issue."
          : "Start it again to let it recover, or skip the issue."}
        {task.error ? (
          <span className="mt-1 block text-destructive-foreground">{task.error}</span>
        ) : null}
      </p>
      <div className="flex flex-wrap items-center gap-2">
        {reason === "rounds" ? (
          <Button
            size="sm"
            disabled={pending !== null}
            onClick={() =>
              void run(
                "retry",
                () =>
                  review({
                    environmentId: context.environmentId,
                    input: {
                      taskId: task.id,
                      action: "retry",
                      feedback: "Please inspect the blocker and continue.",
                    },
                  }),
                {
                  failure: "Could not grant more rounds",
                  success: `${moreRounds} more rounds granted`,
                },
              )
            }
          >
            {pending === "retry" ? <Spinner className="size-3.5" /> : <RotateCcwIcon />}
            Allow {moreRounds} more rounds
          </Button>
        ) : (
          <Button
            size="sm"
            disabled={pending !== null}
            onClick={() =>
              void run(
                "start",
                () =>
                  control({
                    environmentId: context.environmentId,
                    input: { projectId: task.projectId, action: "start" },
                  }),
                { failure: "Could not start the assistant" },
              )
            }
          >
            {pending === "start" ? <Spinner className="size-3.5" /> : <PlayIcon />}
            Start assistant
          </Button>
        )}
        <Button
          size="sm"
          variant="destructive-outline"
          disabled={pending !== null}
          onClick={() => void skip()}
        >
          <SkipForwardIcon />
          Skip issue
        </Button>
      </div>
    </InboxRow>
  );
}

function PausedProjectCard({
  project,
  reason,
  context,
  row,
}: {
  project: AssistantProject;
  reason: string;
  context: InboxContext;
  row: RowState;
}) {
  const control = useAtomCommand(developerAssistant.control);
  const { pending, run } = useAssistantAction();
  const title = context.projectTitle(project.config.projectId);
  return (
    <InboxRow
      {...row}
      accent="paused"
      kind={
        project.status === "running"
          ? "Assistant cannot continue"
          : project.status === "paused"
            ? "Loop paused"
            : "Assistant stopped"
      }
      context={<span className="truncate">{title}</span>}
      summary={reason}
    >
      <div className="flex flex-wrap items-center gap-2">
        <Button
          size="sm"
          disabled={pending !== null}
          onClick={() =>
            void run(
              "start",
              () =>
                control({
                  environmentId: context.environmentId,
                  input: { projectId: project.config.projectId, action: "start" },
                }),
              { failure: `Could not start ${title}`, success: `${title} is running again` },
            )
          }
        >
          {pending ? <Spinner className="size-3.5" /> : <PlayIcon />}
          Start again
        </Button>
      </div>
    </InboxRow>
  );
}

function SetupReadyCard({
  setup,
  context,
  row,
}: {
  setup: AssistantSetup;
  context: InboxContext;
  row: RowState;
}) {
  return (
    <InboxRow
      {...row}
      accent="setup"
      kind="Setup ready to save"
      context={
        <span className="truncate">{context.projectTitle(setup.preferences.projectId)}</span>
      }
      summary={
        previewLine(setup.summary) ||
        "The assistant finished inspecting the project and proposed a setup."
      }
      links={
        <RowLinks
          thread={setup.threadId}
          threadLabel="Open setup chat"
          onOpenThread={context.onOpenThread}
        />
      }
    >
      {setup.summary.trim() ? (
        <ExpandableMarkdown
          text={setup.summary}
          environmentId={context.environmentId}
          collapsedClassName="max-h-32"
        />
      ) : null}
      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" onClick={() => context.onReviewSetup(setup)}>
          Review and save
        </Button>
        <Button size="sm" variant="outline" onClick={() => context.onOpenThread(setup.threadId)}>
          Discuss changes
        </Button>
      </div>
    </InboxRow>
  );
}
