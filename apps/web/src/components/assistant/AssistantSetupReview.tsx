import type {
  AssistantProjectConfig,
  AssistantSetup,
  EnvironmentId,
  ThreadId,
} from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import {
  ArrowRightIcon,
  ChevronRightIcon,
  GitBranchIcon,
  LayoutDashboardIcon,
  RocketIcon,
  SparklesIcon,
  TerminalSquareIcon,
  TriangleAlertIcon,
} from "lucide-react";
import { useState, type ReactNode } from "react";

import { developerAssistant } from "~/state/developerAssistant";
import { useEnvironmentQuery } from "~/state/query";
import { useProjects, useThreadShell } from "~/state/entities";
import { useEnvironments } from "~/state/environments";
import { useAtomCommand } from "~/state/use-atom-command";

import { Button } from "../ui/button";
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "../ui/collapsible";
import {
  Sheet,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetPanel,
  SheetPopup,
  SheetTitle,
} from "../ui/sheet";
import { Spinner } from "../ui/spinner";
import {
  confirmDestructive,
  ExpandableMarkdown,
  modelLabel,
  runtimeModeLabel,
  StatusDot,
  threadIsBusy,
  useAssistantAction,
} from "./assistantUi";

function Section({
  icon: Icon,
  title,
  children,
}: {
  icon: typeof RocketIcon;
  title: string;
  children: ReactNode;
}) {
  return (
    <section className="grid gap-2">
      <h3 className="flex items-center gap-1.5 font-medium text-muted-foreground text-xs uppercase tracking-wide">
        <Icon aria-hidden className="size-3.5" />
        {title}
      </h3>
      <div className="rounded-lg border border-border/60 bg-card p-3">{children}</div>
    </section>
  );
}

function Facts({ children }: { children: ReactNode }) {
  return (
    <dl className="grid grid-cols-[8rem_minmax(0,1fr)] gap-x-3 gap-y-2 text-sm">{children}</dl>
  );
}

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <>
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="min-w-0 break-words">{children}</dd>
    </>
  );
}

/** The proposed configuration, grouped by what each part decides. */
function SetupProposal({
  setup,
  proposal,
  environmentId,
}: {
  setup: AssistantSetup;
  proposal: AssistantProjectConfig;
  environmentId: EnvironmentId;
}) {
  const { environments } = useEnvironments();
  const providers =
    environments.find((e) => e.environmentId === environmentId)?.serverConfig?.providers ?? [];
  return (
    <div className="grid gap-5">
      {setup.summary.trim() ? (
        <ExpandableMarkdown text={setup.summary} environmentId={environmentId} />
      ) : null}

      <Section icon={RocketIcon} title="Delivery">
        <Facts>
          <Fact label="Integration branch">
            <span className="inline-flex items-center gap-1 font-mono text-xs">
              <GitBranchIcon aria-hidden className="size-3.5 text-muted-foreground" />
              {proposal.baseBranch}
            </span>
          </Fact>
          <Fact label="Staging">
            {proposal.stagingUrl ? (
              <a
                href={proposal.stagingUrl}
                target="_blank"
                rel="noreferrer"
                className="underline-offset-2 hover:underline"
              >
                {proposal.stagingUrl}
              </a>
            ) : (
              <span className="text-muted-foreground">Reported by the staging check</span>
            )}
          </Fact>
          {proposal.deploymentTargets?.map((target) => (
            <Fact key={target.id} label={`Deploys ${target.id}`}>
              {target.kind === "github-actions" ? (
                <span>
                  GitHub Actions ·{" "}
                  <span className="font-mono text-xs">
                    {target.repository} / {target.workflow}
                  </span>
                </span>
              ) : (
                <span>
                  Railway ·{" "}
                  <span className="break-all font-mono text-muted-foreground text-xs">
                    service {target.serviceId}
                  </span>
                </span>
              )}
            </Fact>
          ))}
        </Facts>
        {proposal.stagingCheckCommand ? (
          <div className="mt-3 rounded-md border border-warning/40 bg-warning/6 p-3">
            <p className="flex items-center gap-1.5 font-medium text-sm">
              <TerminalSquareIcon aria-hidden className="size-4" />
              Custom staging check
            </p>
            <pre className="mt-2 whitespace-pre-wrap break-all rounded bg-background/60 px-2 py-1.5 font-mono text-xs">
              {proposal.stagingCheckCommand}
            </pre>
            <p className="mt-2 text-muted-foreground text-xs">
              Saving lets T3 run this command at the project root each time it verifies staging.
            </p>
          </div>
        ) : null}
      </Section>

      <Section icon={LayoutDashboardIcon} title="Issues and agents">
        <Facts>
          <Fact label="Takes issues">
            {proposal.assignedToMe ? "Assigned to you" : "Anyone's"} in{" "}
            {proposal.readyStates.length ? proposal.readyStates.join(", ") : "unstarted states"}
          </Fact>
          <Fact label="Assistant">{modelLabel(providers, proposal.modelSelection)}</Fact>
          <Fact label="Coding worker">{modelLabel(providers, proposal.workerModelSelection)}</Fact>
          <Fact label="Permissions">{runtimeModeLabel(proposal.runtimeMode)}</Fact>
          <Fact label="Rounds per issue">{proposal.maxWorkerTurns}, then it asks you</Fact>
          <Fact label="Linear status">
            <span className="inline-flex flex-wrap items-center gap-1">
              Staging verified
              <ArrowRightIcon aria-hidden className="size-3 text-muted-foreground" />
              {proposal.reviewState || <span className="text-muted-foreground">unchanged</span>}
              <span className="text-muted-foreground">·</span>
              Accepted
              <ArrowRightIcon aria-hidden className="size-3 text-muted-foreground" />
              {proposal.acceptedState || <span className="text-muted-foreground">unchanged</span>}
            </span>
          </Fact>
        </Facts>
      </Section>

      <Collapsible>
        <CollapsibleTrigger className="group inline-flex items-center gap-1 font-medium text-muted-foreground text-xs uppercase tracking-wide hover:text-foreground">
          <ChevronRightIcon
            aria-hidden
            className="size-3.5 transition-transform group-data-panel-open:rotate-90"
          />
          Project instructions
        </CollapsibleTrigger>
        <CollapsiblePanel>
          <div className="mt-2 rounded-lg border border-border/60 p-3">
            <p className="mb-2 text-muted-foreground text-xs">
              The assistant and every coding worker read these on each issue.
            </p>
            {proposal.instructions.trim() ? (
              <ExpandableMarkdown text={proposal.instructions} environmentId={environmentId} />
            ) : (
              <p className="text-muted-foreground text-sm">None yet.</p>
            )}
          </div>
        </CollapsiblePanel>
      </Collapsible>
    </div>
  );
}

/** Review a proposed setup and save or discard it. */
export function AssistantSetupSheet({
  setup,
  environmentId,
  open,
  onOpenChange,
  onResolved,
  onOpenThread,
}: {
  setup: AssistantSetup | null;
  environmentId: EnvironmentId;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onResolved?: (action: "save" | "cancel") => void;
  onOpenThread?: (threadId: ThreadId) => void;
}) {
  const resolve = useAtomCommand(developerAssistant.resolveSetup);
  const { pending, run } = useAssistantAction();
  const thread = useThreadShell(setup ? { environmentId, threadId: setup.threadId } : null);
  const projects = useProjects();
  const title = projects.find((p) => p.id === setup?.preferences.projectId)?.title ?? "project";
  const working =
    threadIsBusy(thread) || Boolean(thread?.hasPendingApprovals || thread?.hasPendingUserInput);

  const act = async (action: "save" | "cancel") => {
    if (!setup) return;
    if (
      action === "cancel" &&
      !(await confirmDestructive(
        `Cancel the setup for ${title}?\nThe conversation stays in your history. Nothing it proposed is applied.`,
      ))
    )
      return;
    const ok = await run(
      action,
      () =>
        resolve({
          environmentId,
          input: { threadId: setup.threadId, revision: setup.revision, action },
        }),
      {
        failure: action === "save" ? "Could not save the setup" : "Could not cancel the setup",
        success:
          action === "save"
            ? `${title} is set up. Press Start when you want it to take issues.`
            : "Setup cancelled",
      },
    );
    if (ok) {
      onOpenChange(false);
      onResolved?.(action);
    }
  };

  return (
    <Sheet open={open && setup !== null} onOpenChange={(next) => !pending && onOpenChange(next)}>
      <SheetPopup side="right" className="max-w-xl">
        <SheetHeader>
          <SheetTitle className="flex items-center gap-2">
            <SparklesIcon className="size-4" />
            Review {title} setup
          </SheetTitle>
          <SheetDescription>
            Your assistant proposed this after inspecting the project. Ask for corrections in the
            conversation; it can revise the proposal before you save.
          </SheetDescription>
        </SheetHeader>
        <SheetPanel>
          {setup?.proposal ? (
            <SetupProposal setup={setup} proposal={setup.proposal} environmentId={environmentId} />
          ) : (
            <p className="text-muted-foreground text-sm">
              The assistant has not proposed a setup yet.
            </p>
          )}
        </SheetPanel>
        <SheetFooter className="items-center">
          {working ? (
            <p
              role="status"
              className="flex min-w-0 flex-1 items-center gap-1.5 text-muted-foreground text-xs"
            >
              <TriangleAlertIcon aria-hidden className="size-3.5 shrink-0" />
              Waiting for the setup conversation to finish its turn.
            </p>
          ) : (
            <p className="min-w-0 flex-1 text-muted-foreground text-xs">
              Saving keeps the assistant paused until you press Start.
            </p>
          )}
          {setup && onOpenThread ? (
            <Button
              size="sm"
              variant="ghost"
              disabled={pending !== null}
              onClick={() => {
                onOpenChange(false);
                onOpenThread(setup.threadId);
              }}
            >
              Discuss changes
            </Button>
          ) : null}
          <Button
            size="sm"
            variant="destructive-outline"
            disabled={pending !== null}
            onClick={() => void act("cancel")}
          >
            Cancel setup
          </Button>
          <Button
            size="sm"
            disabled={pending !== null || !setup?.proposal || working || !thread}
            onClick={() => void act("save")}
          >
            {pending === "save" ? <Spinner className="size-3.5" /> : null}
            Save setup
          </Button>
        </SheetFooter>
      </SheetPopup>
    </Sheet>
  );
}

/**
 * A slim bar over a setup conversation: what the setup is waiting on, and the
 * way to its review once there is something to review.
 */
export function AssistantSetupThreadPanel({
  environmentId,
  threadId,
}: {
  environmentId: EnvironmentId;
  threadId: ThreadId;
}) {
  const board = useEnvironmentQuery(developerAssistant.board({ environmentId, input: {} }));
  const setup = board.data?.setups?.find((s) => s.threadId === threadId) ?? null;
  const thread = useThreadShell({ environmentId, threadId });
  const projects = useProjects();
  const navigate = useNavigate();
  const [reviewing, setReviewing] = useState(false);
  if (!setup) return null;
  const busy = threadIsBusy(thread);
  const title = projects.find((p) => p.id === setup.preferences.projectId)?.title ?? "project";
  const status = busy
    ? "Your assistant is inspecting the project"
    : setup.proposal
      ? `Proposed setup ready${setup.revision > 1 ? ` (revision ${setup.revision})` : ""}`
      : "Waiting for your reply below";
  const toBoard = () => void navigate({ to: "/assistant", search: { environment: environmentId } });
  return (
    <div className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1.5 border-b bg-muted/30 px-4 py-2 sm:px-5">
      <span className="flex min-w-0 flex-1 items-center gap-2 text-sm">
        <StatusDot tone={setup.proposal && !busy ? "attention" : "waiting"} pulse={busy} />
        <span className="shrink-0 font-medium">Setting up {title}</span>
        <span className="min-w-0 truncate text-muted-foreground">· {status}</span>
      </span>
      <span className="flex items-center gap-1.5">
        <Button size="xs" variant="ghost" onClick={toBoard}>
          Assistant board
        </Button>
        {setup.proposal ? (
          <Button size="xs" onClick={() => setReviewing(true)}>
            Review and save
          </Button>
        ) : null}
      </span>
      <AssistantSetupSheet
        setup={setup}
        environmentId={environmentId}
        open={reviewing}
        onOpenChange={setReviewing}
        onResolved={toBoard}
      />
    </div>
  );
}
