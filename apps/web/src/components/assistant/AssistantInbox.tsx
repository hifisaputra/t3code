import type {
  AssistantDecision,
  AssistantProject,
  AssistantSetup,
  AssistantTask,
  EnvironmentId,
  ThreadId,
} from "@t3tools/contracts";
import {
  ArrowUpRightIcon,
  CheckIcon,
  CopyIcon,
  ExternalLinkIcon,
  GitCommitHorizontalIcon,
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

import { useCopyToClipboard } from "~/hooks/useCopyToClipboard";
import { cn, isMacPlatform } from "~/lib/utils";
import { developerAssistant } from "~/state/developerAssistant";
import { useAtomCommand } from "~/state/use-atom-command";
import { formatRelativeTimeLabel } from "~/timestampFormat";

import { Button } from "../ui/button";
import { Kbd } from "../ui/kbd";
import { Spinner } from "../ui/spinner";
import { Textarea } from "../ui/textarea";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { decisionOptions, type InboxItem } from "./assistantBoard.logic";
import {
  confirmDestructive,
  ExpandableMarkdown,
  IssueLink,
  useAssistantAction,
} from "./assistantUi";

type Accent = "question" | "review" | "blocked" | "paused" | "setup";

const ACCENT: Record<Accent, { icon: typeof CheckIcon; tint: string }> = {
  question: { icon: MessageCircleQuestionIcon, tint: "bg-info/10 text-info-foreground" },
  review: { icon: CheckIcon, tint: "bg-success/10 text-success-foreground" },
  blocked: { icon: OctagonAlertIcon, tint: "bg-destructive/10 text-destructive-foreground" },
  paused: { icon: PauseCircleIcon, tint: "bg-warning/12 text-warning-foreground" },
  setup: { icon: SparklesIcon, tint: "bg-info/10 text-info-foreground" },
};

function InboxCard({
  accent,
  kind,
  context,
  at,
  onOpenThread,
  openThreadLabel = "Open thread",
  children,
}: {
  accent: Accent;
  kind: string;
  context: ReactNode;
  at?: string | null;
  onOpenThread?: () => void;
  openThreadLabel?: string;
  children: ReactNode;
}) {
  const { icon: Icon, tint } = ACCENT[accent];
  return (
    <article className="rounded-xl border border-border/70 bg-card shadow-xs/5">
      <header className="flex min-w-0 items-center gap-2 px-4 pt-3 text-xs">
        <span className={cn("flex size-5 shrink-0 items-center justify-center rounded-md", tint)}>
          <Icon aria-hidden className="size-3.5" />
        </span>
        <span className="shrink-0 font-medium text-foreground">{kind}</span>
        <span className="flex min-w-0 items-center gap-1.5 text-muted-foreground">{context}</span>
        {at ? (
          <span className="ml-auto shrink-0 text-muted-foreground/80 tabular-nums">
            {formatRelativeTimeLabel(at)}
          </span>
        ) : null}
        {onOpenThread ? (
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  size="icon-xs"
                  variant="ghost"
                  className={at ? undefined : "ml-auto"}
                  aria-label={openThreadLabel}
                  onClick={onOpenThread}
                />
              }
            >
              <ArrowUpRightIcon />
            </TooltipTrigger>
            <TooltipPopup>{openThreadLabel}</TooltipPopup>
          </Tooltip>
        ) : null}
      </header>
      <div className="flex flex-col gap-3 px-4 pt-2 pb-4">{children}</div>
    </article>
  );
}

function Context({
  project,
  issue,
}: {
  project: string | null;
  issue?: AssistantTask["issue"] | undefined;
}) {
  return (
    <>
      {project ? <span className="truncate">· {project}</span> : null}
      {issue ? (
        <>
          <span aria-hidden>·</span>
          <IssueLink issue={issue} />
        </>
      ) : null}
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
}

export function InboxItemCard({ item, context }: { item: InboxItem; context: InboxContext }) {
  switch (item.kind) {
    case "decision":
      return <DecisionCard decision={item.decision} context={context} />;
    case "review":
      return <ReviewCard task={item.task} context={context} />;
    case "stuck":
      return <StuckTaskCard task={item.task} reason={item.reason} context={context} />;
    case "paused":
      return <PausedProjectCard project={item.project} reason={item.reason} context={context} />;
    case "setup":
      return <SetupReadyCard setup={item.setup} context={context} />;
  }
}

function DecisionCard({
  decision,
  context,
}: {
  decision: AssistantDecision;
  context: InboxContext;
}) {
  const answer = useAtomCommand(developerAssistant.answer);
  const { pending, run } = useAssistantAction();
  const [draft, setDraft] = useState("");
  const task = decision.taskId ? context.tasks.find((t) => t.id === decision.taskId) : undefined;
  const options = decision.kind === "decision" ? decisionOptions(decision.question) : [];
  const fromWorker = task !== undefined;
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
      <InboxCard
        accent="question"
        kind={approval ? "Permission request" : "Question in thread"}
        context={<Context project={context.projectLabel(decision.projectId)} issue={task?.issue} />}
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
      </InboxCard>
    );
  }

  return (
    <InboxCard
      accent="question"
      kind={fromWorker ? "Worker question" : "Decision needed"}
      context={<Context project={context.projectLabel(decision.projectId)} issue={task?.issue} />}
      at={decision.createdAt}
      onOpenThread={() => context.onOpenThread(decision.threadId)}
      openThreadLabel={fromWorker ? "Open worker thread" : "Open assistant chat"}
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
        <div className="flex items-center gap-2">
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
    </InboxCard>
  );
}

function CommitChip({ revision }: { revision: string }) {
  const { copyToClipboard, isCopied } = useCopyToClipboard();
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            type="button"
            onClick={() => copyToClipboard(revision, undefined)}
            className="inline-flex items-center gap-1 rounded-md border border-border/60 px-1.5 py-0.5 font-mono text-[11px] text-muted-foreground hover:bg-accent hover:text-foreground"
          />
        }
      >
        <GitCommitHorizontalIcon aria-hidden className="size-3" />
        {revision.slice(0, 7)}
        {isCopied ? (
          <CheckIcon aria-hidden className="size-3" />
        ) : (
          <CopyIcon aria-hidden className="size-3 opacity-60" />
        )}
      </TooltipTrigger>
      <TooltipPopup>
        {isCopied
          ? "Copied"
          : "The commit verified on staging. Later issues may have landed since."}
      </TooltipPopup>
    </Tooltip>
  );
}

function ReviewCard({ task, context }: { task: AssistantTask; context: InboxContext }) {
  const review = useAtomCommand(developerAssistant.review);
  const { pending, run } = useAssistantAction();
  const [requesting, setRequesting] = useState(false);
  const [feedback, setFeedback] = useState("");
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

  return (
    <InboxCard
      accent="review"
      kind="Ready for review"
      context={<Context project={context.projectLabel(task.projectId)} issue={task.issue} />}
      at={task.deployment?.verifiedAt ?? task.updatedAt}
      onOpenThread={() => context.onOpenThread(task.threadId)}
      openThreadLabel="Open worker thread"
    >
      <h3 className="font-semibold text-sm leading-snug">{task.issue.title}</h3>
      {task.summary.trim() ? (
        <ExpandableMarkdown text={task.summary} environmentId={context.environmentId} />
      ) : null}
      {task.reviewInstructions.trim() ? (
        <div className="rounded-lg bg-muted/50 px-3 py-2.5">
          <p className="mb-1 font-medium text-muted-foreground text-xs uppercase tracking-wide">
            How to check it
          </p>
          <ExpandableMarkdown
            text={task.reviewInstructions}
            environmentId={context.environmentId}
            collapsedClassName="max-h-40"
          />
        </div>
      ) : null}
      {task.error ? (
        <p className="rounded-lg bg-warning/8 px-3 py-2 text-warning-foreground text-xs">
          {task.error}
        </p>
      ) : null}
      {task.deployment ? (
        <div className="flex flex-wrap items-center gap-2">
          <Button
            size="xs"
            variant="outline"
            render={<a href={task.deployment.url} target="_blank" rel="noreferrer" />}
          >
            <ExternalLinkIcon />
            Open staging
          </Button>
          <CommitChip revision={task.deployment.revision} />
          {task.deployment.evidence?.map((entry) => (
            <span
              key={entry.targetId}
              className="inline-flex items-center gap-1 text-[11px] text-muted-foreground"
            >
              <CheckIcon aria-hidden className="size-3 text-success-foreground" />
              {entry.targetId} deployed
            </span>
          ))}
        </div>
      ) : null}
      {requesting ? (
        <form
          className="flex flex-col gap-2"
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
      ) : (
        <div className="flex flex-wrap items-center gap-2 border-border/60 border-t pt-3">
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
        </div>
      )}
    </InboxCard>
  );
}

function StuckTaskCard({
  task,
  reason,
  context,
}: {
  task: AssistantTask;
  reason: "rounds" | "stopped";
  context: InboxContext;
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
    <InboxCard
      accent="blocked"
      kind={reason === "rounds" ? "Out of work rounds" : "Stuck while paused"}
      context={<Context project={context.projectLabel(task.projectId)} issue={task.issue} />}
      at={task.updatedAt}
      onOpenThread={() => context.onOpenThread(task.threadId)}
      openThreadLabel="Open worker thread"
    >
      <h3 className="font-semibold text-sm leading-snug">{task.issue.title}</h3>
      <p className="text-muted-foreground text-sm">
        {reason === "rounds"
          ? `The worker used all ${task.turnLimit} rounds without finishing. Give it more, or skip the issue.`
          : "The assistant is paused with this issue unfinished. Start it again to let it recover, or skip the issue."}
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
    </InboxCard>
  );
}

function PausedProjectCard({
  project,
  reason,
  context,
}: {
  project: AssistantProject;
  reason: string;
  context: InboxContext;
}) {
  const control = useAtomCommand(developerAssistant.control);
  const { pending, run } = useAssistantAction();
  const title = context.projectTitle(project.config.projectId);
  return (
    <InboxCard
      accent="paused"
      kind="Assistant stopped"
      context={<Context project={title} />}
      onOpenThread={() => context.onOpenThread(project.threadId)}
      openThreadLabel="Open assistant chat"
    >
      <p className="text-sm">{reason}</p>
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
        <Button size="sm" variant="outline" onClick={() => context.onOpenThread(project.threadId)}>
          Ask what happened
        </Button>
      </div>
    </InboxCard>
  );
}

function SetupReadyCard({ setup, context }: { setup: AssistantSetup; context: InboxContext }) {
  return (
    <InboxCard
      accent="setup"
      kind="Setup ready to save"
      context={<Context project={context.projectTitle(setup.preferences.projectId)} />}
      onOpenThread={() => context.onOpenThread(setup.threadId)}
      openThreadLabel="Open setup chat"
    >
      {setup.summary.trim() ? (
        <ExpandableMarkdown
          text={setup.summary}
          environmentId={context.environmentId}
          collapsedClassName="max-h-32"
        />
      ) : (
        <p className="text-muted-foreground text-sm">
          The assistant finished inspecting the project and proposed a setup.
        </p>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" onClick={() => context.onReviewSetup(setup)}>
          Review and save
        </Button>
        <Button size="sm" variant="outline" onClick={() => context.onOpenThread(setup.threadId)}>
          Discuss changes
        </Button>
      </div>
    </InboxCard>
  );
}
