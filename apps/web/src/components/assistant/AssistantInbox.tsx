import {
  assistantThreadKind,
  type AssistantDecision,
  type AssistantProject,
  type AssistantSetup,
  type AssistantTaskSummary,
  type EnvironmentId,
  type ThreadId,
} from "@t3tools/contracts";
import {
  ArrowUpRightIcon,
  CheckIcon,
  ChevronDownIcon,
  MessageCircleQuestionIcon,
  OctagonAlertIcon,
  PauseCircleIcon,
  PlayIcon,
  RotateCcwIcon,
  SendHorizontalIcon,
  ShieldQuestionIcon,
  SkipForwardIcon,
  SparklesIcon,
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
import { decisionOptions, previewLine, type InboxItem } from "./assistantBoard.logic";
import {
  confirmDestructive,
  ExpandableMarkdown,
  IssueLink,
  StatusDot,
  useAssistantAction,
  type StatusTone,
} from "./assistantUi";
import { reviewOutcomeLine, reviewSummary, type ReviewVerdictTone } from "./reviewCard.logic";
import { THREAD_KIND, ResearchBadge } from "./threadKinds";

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
  issue?: AssistantTaskSummary["issue"] | undefined;
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
  issue?: AssistantTaskSummary["issue"] | undefined;
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
  tasks: ReadonlyArray<AssistantTaskSummary>;
  projects: ReadonlyArray<AssistantProject>;
  onOpenThread: (threadId: ThreadId) => void;
  /** Opens one finished issue to read and answer; see AssistantReviewView. */
  onOpenReview: (taskId: string) => void;
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
      return <ReviewRow task={item.task} context={context} row={row} />;
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
                  <span className="shrink-0 font-medium text-3xs text-info-foreground uppercase tracking-wide">
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
 * Finished work waiting to be accepted, as one row: what it is, how the run
 * went, and the way in. The reading — the summary, the tester's evidence, the
 * screenshots and the recordings — happens in the review view, which is where
 * the files are fetched. Work with nothing left to check can be accepted from
 * here without opening it at all.
 */
function ReviewRow({
  task,
  context,
  row,
}: {
  task: AssistantTaskSummary;
  context: InboxContext;
  row: RowState;
}) {
  const review = useAtomCommand(developerAssistant.review);
  const { pending, run } = useAssistantAction();
  const summary = reviewSummary(task);
  const tone = VERDICT_TONE[summary.verdict.tone];
  const open = () => context.onOpenReview(task.id);
  return (
    <article
      id={row.id}
      className="relative flex min-w-0 scroll-mt-4 items-start gap-3 rounded-xl border border-border/70 bg-card px-4 py-3 shadow-xs/5 transition-colors hover:bg-accent/40"
    >
      <span
        className={cn(
          "mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-md",
          ACCENT.review.tint,
        )}
      >
        <CheckIcon aria-hidden className="size-3.5" />
      </span>
      <button
        type="button"
        onClick={open}
        className="block min-w-0 flex-1 text-left after:absolute after:inset-0 after:rounded-xl focus-visible:outline-none"
      >
        <span className="flex min-w-0 items-center gap-1.5 text-xs">
          <span className="shrink-0 font-medium">{summary.kind}</span>
          <span className="flex min-w-0 items-center gap-1.5 text-muted-foreground">
            <span aria-hidden>·</span>
            <span className="shrink-0 font-mono">{task.issue.identifier}</span>
            <ResearchBadge track={task.track} />
            {context.projectLabel(task.projectId) ? (
              <span className="min-w-0 truncate">{context.projectLabel(task.projectId)}</span>
            ) : null}
          </span>
          <span className="ml-auto shrink-0 pl-2 text-muted-foreground/80 tabular-nums">
            {formatRelativeTimeLabel(task.deployment?.verifiedAt ?? task.updatedAt)}
          </span>
        </span>
        <span className="mt-0.5 block truncate font-medium text-sm">{task.issue.title}</span>
        <span className="mt-0.5 flex min-w-0 items-center gap-1.5 text-xs">
          <StatusDot tone={tone.dot} className="shrink-0" />
          <span className="min-w-0 truncate text-muted-foreground">
            {reviewOutcomeLine(summary)}
          </span>
        </span>
      </button>
      <div className="relative z-10 flex shrink-0 items-center gap-1.5 self-center">
        {summary.nothingToCheck ? (
          <Button
            size="xs"
            variant="outline"
            disabled={pending !== null}
            onClick={() =>
              void run(
                "accept",
                () =>
                  review({
                    environmentId: context.environmentId,
                    input: { taskId: task.id, action: "accept", feedback: "" },
                  }),
                {
                  failure: "Could not accept the work",
                  success: `${task.issue.identifier} accepted`,
                },
              )
            }
          >
            {pending === "accept" ? <Spinner className="size-3.5" /> : <CheckIcon />}
            Accept
          </Button>
        ) : null}
        <Button size="xs" onClick={open}>
          Review
          <ArrowUpRightIcon />
        </Button>
      </div>
    </article>
  );
}

function StuckTaskCard({
  task,
  reason,
  context,
  row,
}: {
  task: AssistantTaskSummary;
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
