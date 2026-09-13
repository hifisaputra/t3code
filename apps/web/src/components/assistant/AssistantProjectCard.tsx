import type {
  AssistantProject,
  AssistantSetup,
  AssistantTask,
  EnvironmentId,
  ServerProvider,
  ThreadId,
} from "@t3tools/contracts";
import {
  ArrowRightIcon,
  EllipsisIcon,
  GitBranchIcon,
  GlobeIcon,
  MessageSquareIcon,
  OctagonXIcon,
  PauseIcon,
  PlayIcon,
  RefreshCwIcon,
  Settings2Icon,
  XIcon,
} from "lucide-react";
import type { ReactNode } from "react";

import { cn } from "~/lib/utils";
import { developerAssistant } from "~/state/developerAssistant";
import { useThreadShell } from "~/state/entities";
import { useAtomCommand } from "~/state/use-atom-command";

import { Button } from "../ui/button";
import { Menu, MenuItem, MenuPopup, MenuSeparator, MenuTrigger } from "../ui/menu";
import { Spinner } from "../ui/spinner";
import { describeProjectActivity } from "./assistantBoard.logic";
import {
  confirmDestructive,
  modelLabel,
  runtimeModeLabel,
  StatusDot,
  threadIsBusy,
  urlHost,
  useAssistantAction,
  type StatusTone,
} from "./assistantUi";

function CardShell({ children, tone }: { children: ReactNode; tone?: StatusTone }) {
  return (
    <article
      className={cn(
        "flex flex-col gap-3 rounded-xl border bg-card p-4 shadow-xs/5",
        tone === "attention" ? "border-warning/40" : "border-border/70",
      )}
    >
      {children}
    </article>
  );
}

function StatusPill({ tone, label, pulse }: { tone: StatusTone; label: string; pulse?: boolean }) {
  return (
    <span className="inline-flex shrink-0 items-center gap-1.5 rounded-full border border-border/60 px-2 py-0.5 text-[11px] text-muted-foreground">
      <StatusDot tone={tone} pulse={pulse ?? false} className="size-1.5" />
      {label}
    </span>
  );
}

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <>
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="min-w-0 truncate text-foreground">{children}</dd>
    </>
  );
}

export function AssistantProjectCard({
  environmentId,
  project,
  title,
  activeTask,
  linearProjectName,
  providers,
  onOpenThread,
  onEditSetup,
}: {
  environmentId: EnvironmentId;
  project: AssistantProject;
  title: string;
  activeTask: AssistantTask | null;
  linearProjectName: string | null;
  providers: ReadonlyArray<ServerProvider>;
  onOpenThread: (threadId: ThreadId) => void;
  onEditSetup: () => void;
}) {
  const control = useAtomCommand(developerAssistant.control);
  const { pending, run } = useAssistantAction();
  const coordinator = useThreadShell({ environmentId, threadId: project.threadId });
  const coordinatorBusy = threadIsBusy(coordinator);
  const activity = describeProjectActivity({ project, activeTask, coordinatorBusy });
  const { config } = project;
  const running = project.status === "running";
  const projectId = config.projectId;

  const act = (action: "start" | "stop" | "interrupt" | "wake") =>
    run(action, () => control({ environmentId, input: { projectId, action } }), {
      failure:
        action === "start"
          ? `Could not start ${title}`
          : action === "wake"
            ? "Could not wake the assistant"
            : `Could not pause ${title}`,
    });

  const canEdit = !running && activeTask === null;
  const stagingHost = urlHost(config.stagingUrl);

  return (
    <CardShell tone={activity.tone}>
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <h3 className="truncate font-semibold text-sm">{title}</h3>
          <p className="mt-0.5 truncate text-muted-foreground text-xs">
            {linearProjectName ?? "Linear project"} ·{" "}
            {config.assignedToMe ? "your issues" : "all issues"}
          </p>
        </div>
        <StatusPill
          tone={activity.tone}
          label={activity.status}
          pulse={activity.tone === "active" && coordinatorBusy}
        />
      </div>

      <div
        className={cn(
          "rounded-lg px-3 py-2.5",
          activity.tone === "attention" ? "bg-warning/8" : "bg-muted/50",
        )}
      >
        <p className="flex items-center gap-2 font-medium text-sm">
          <StatusDot tone={activity.tone} pulse={activity.tone === "active"} />
          <span className="min-w-0 truncate">{activity.headline}</span>
        </p>
        {activity.detail ? (
          <p
            className={cn(
              "mt-1 line-clamp-3 text-xs",
              activity.tone === "attention" ? "text-warning-foreground" : "text-muted-foreground",
            )}
          >
            {activity.detail}
          </p>
        ) : null}
      </div>

      <dl className="grid grid-cols-[4.75rem_minmax(0,1fr)] gap-x-3 gap-y-1.5 text-xs">
        <Fact label="Delivers to">
          <span className="inline-flex min-w-0 items-center gap-1">
            <GitBranchIcon aria-hidden className="size-3 shrink-0 text-muted-foreground" />
            <span className="font-mono">{config.baseBranch}</span>
            {stagingHost ? (
              <>
                <ArrowRightIcon aria-hidden className="size-3 shrink-0 text-muted-foreground" />
                <a
                  href={config.stagingUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex min-w-0 items-center gap-1 underline-offset-2 hover:underline"
                >
                  <GlobeIcon aria-hidden className="size-3 shrink-0 text-muted-foreground" />
                  <span className="truncate">{stagingHost}</span>
                </a>
              </>
            ) : null}
          </span>
        </Fact>
        <Fact label="Models">
          {modelLabel(providers, config.modelSelection)}
          {config.workerModelSelection.model !== config.modelSelection.model ||
          config.workerModelSelection.instanceId !== config.modelSelection.instanceId
            ? ` · ${modelLabel(providers, config.workerModelSelection)} codes`
            : ""}
        </Fact>
        <Fact label="Permissions">{runtimeModeLabel(config.runtimeMode)}</Fact>
      </dl>

      <div className="flex items-center gap-1.5">
        <Button
          size="sm"
          variant={running ? "outline" : "default"}
          disabled={pending !== null}
          onClick={() => void act(running ? "stop" : "start")}
        >
          {pending === "start" || pending === "stop" ? (
            <Spinner className="size-3.5" />
          ) : running ? (
            <PauseIcon />
          ) : (
            <PlayIcon />
          )}
          {running ? "Pause" : "Start"}
        </Button>
        <Button size="sm" variant="outline" onClick={() => onOpenThread(project.threadId)}>
          <MessageSquareIcon />
          Chat
        </Button>
        <Menu>
          <MenuTrigger
            render={
              <Button
                size="icon-sm"
                variant="ghost"
                className="ml-auto"
                aria-label={`More actions for ${title}`}
              />
            }
          >
            <EllipsisIcon />
          </MenuTrigger>
          <MenuPopup align="end" className="min-w-52">
            <MenuItem disabled={!running || pending !== null} onClick={() => void act("wake")}>
              <RefreshCwIcon />
              Check for work now
            </MenuItem>
            <MenuItem disabled={!canEdit} onClick={onEditSetup}>
              <Settings2Icon />
              {canEdit
                ? "Revise setup"
                : running
                  ? "Revise setup (pause first)"
                  : "Revise setup (finish the issue first)"}
            </MenuItem>
            <MenuSeparator />
            <MenuItem
              variant="destructive"
              disabled={pending !== null || (!running && activeTask === null)}
              onClick={async () => {
                const confirmed = await confirmDestructive(
                  `Interrupt ${title}?\nThis pauses the assistant, stops the coding worker mid-turn and closes its terminals. The issue and its branch stay as they are, so you can start again later.`,
                );
                if (confirmed) void act("interrupt");
              }}
            >
              <OctagonXIcon />
              Interrupt all work
            </MenuItem>
          </MenuPopup>
        </Menu>
      </div>
    </CardShell>
  );
}

export function AssistantSetupCard({
  environmentId,
  setup,
  title,
  onOpenThread,
  onReview,
}: {
  environmentId: EnvironmentId;
  setup: AssistantSetup;
  title: string;
  onOpenThread: (threadId: ThreadId) => void;
  onReview: () => void;
}) {
  const resolve = useAtomCommand(developerAssistant.resolveSetup);
  const { pending, run } = useAssistantAction();
  const thread = useThreadShell({ environmentId, threadId: setup.threadId });
  const busy = threadIsBusy(thread);
  const needsReply = !busy && (thread?.hasPendingApprovals || thread?.hasPendingUserInput);
  const headline = busy
    ? "Inspecting the project"
    : needsReply
      ? "Waiting for you in the conversation"
      : setup.proposal
        ? "Proposal ready to review"
        : "Waiting for your reply";
  return (
    <CardShell>
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <h3 className="truncate font-semibold text-sm">{title}</h3>
          <p className="mt-0.5 text-muted-foreground text-xs">Being set up</p>
        </div>
        <StatusPill
          tone={setup.proposal && !busy ? "attention" : "waiting"}
          label="Setup"
          pulse={busy}
        />
      </div>
      <p className="flex items-center gap-2 rounded-lg bg-muted/50 px-3 py-2.5 font-medium text-sm">
        <StatusDot tone={setup.proposal && !busy ? "attention" : "waiting"} pulse={busy} />
        {headline}
      </p>
      <div className="flex items-center gap-1.5">
        {setup.proposal ? (
          <Button size="sm" onClick={onReview}>
            Review setup
          </Button>
        ) : null}
        <Button
          size="sm"
          variant={setup.proposal ? "outline" : "default"}
          onClick={() => onOpenThread(setup.threadId)}
        >
          <MessageSquareIcon />
          {setup.proposal ? "Chat" : "Continue in chat"}
        </Button>
        <Menu>
          <MenuTrigger
            render={
              <Button
                size="icon-sm"
                variant="ghost"
                className="ml-auto"
                aria-label={`More actions for ${title} setup`}
              />
            }
          >
            <EllipsisIcon />
          </MenuTrigger>
          <MenuPopup align="end" className="min-w-44">
            <MenuItem
              variant="destructive"
              disabled={pending !== null}
              onClick={async () => {
                const confirmed = await confirmDestructive(
                  `Cancel the setup for ${title}?\nThe conversation stays in your history. Nothing it proposed is applied.`,
                );
                if (!confirmed) return;
                void run(
                  "cancel",
                  () =>
                    resolve({
                      environmentId,
                      input: {
                        threadId: setup.threadId,
                        revision: setup.revision,
                        action: "cancel",
                      },
                    }),
                  { failure: "Could not cancel the setup", success: "Setup cancelled" },
                );
              }}
            >
              <XIcon />
              Cancel setup
            </MenuItem>
          </MenuPopup>
        </Menu>
      </div>
    </CardShell>
  );
}
