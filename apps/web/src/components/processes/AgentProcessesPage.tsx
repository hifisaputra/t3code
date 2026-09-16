/**
 * Processes: the commands agents started and left running.
 *
 * Grouped by project and thread so a row can be traced back to the work that
 * started it. The data is a server-push subscription — the page never polls
 * and never animates; it renders what the last snapshot said.
 *
 * @module components/processes/AgentProcessesPage
 */
import { useAtomValue } from "@effect/atom-react";
import { Link } from "@tanstack/react-router";
import type { AgentProcess, EnvironmentId } from "@t3tools/contracts";
import { memo, useMemo } from "react";

import { resolveDiscoveredServerUrl } from "../../browser/browserTargetResolver";
import { isElectron } from "../../env";
import { useAgentProcesses } from "../../state/agentProcesses";
import { environmentPresentations } from "../../state/presentation";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { ScrollArea } from "../ui/scroll-area";
import { SidebarInset } from "../ui/sidebar";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { WorkspaceBreadcrumb, WorkspaceBreadcrumbItem } from "../WorkspaceBreadcrumb";
import { WorkspacePageContainer } from "../WorkspacePageContainer";
import { WorkspacePageHeader } from "../WorkspacePageHeader";
import {
  formatUptime,
  groupAgentProcesses,
  pathBasename,
  shortenCommand,
  type AgentProcessProjectGroup,
  type AgentProcessThreadGroup,
} from "./agentProcessesModel";
import {
  agentProcessStopKey,
  useStopAgentProcess,
  type AgentProcessStopStatus,
  type StopAgentProcessController,
} from "./useStopAgentProcess";

export function AgentProcessesPage() {
  const { entries, unsupportedEnvironmentIds } = useAgentProcesses();
  const presentations = useAtomValue(environmentPresentations.presentationsAtom);
  const stopController = useStopAgentProcess();

  const groups = useMemo(() => groupAgentProcesses(entries), [entries]);
  // Only worth naming the machine when there is more than one to confuse.
  const environmentLabels = useMemo(
    () =>
      presentations.size < 2
        ? null
        : new Map(
            Array.from(presentations, ([environmentId, presentation]) => [
              environmentId,
              presentation.entry.target.label,
            ]),
          ),
    [presentations],
  );

  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none bg-background text-foreground isolate">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-background text-foreground">
        <WorkspacePageHeader electron={isElectron}>
          <WorkspaceBreadcrumb ariaLabel="Processes breadcrumb" className="min-w-0">
            <WorkspaceBreadcrumbItem current>
              <h1>Processes</h1>
            </WorkspaceBreadcrumbItem>
          </WorkspaceBreadcrumb>
        </WorkspacePageHeader>

        <ScrollArea className="min-h-0 flex-1">
          <WorkspacePageContainer width="wide">
            <p className="text-sm text-muted-foreground">
              Commands agents started that are still running.
            </p>

            {unsupportedEnvironmentIds.map((environmentId) => (
              <p key={environmentId} className="text-sm text-muted-foreground">
                {environmentLabels?.get(environmentId) === undefined
                  ? "Process tracking is not available on Windows servers."
                  : `${environmentLabels.get(environmentId)}: process tracking is not available on Windows servers.`}
              </p>
            ))}

            {groups.length === 0 ? (
              <p className="text-sm text-muted-foreground">No agent processes are running.</p>
            ) : (
              groups.map((group) => (
                <ProjectGroupSection
                  key={group.key}
                  group={group}
                  environmentLabel={environmentLabels?.get(group.environmentId) ?? null}
                  stopController={stopController}
                />
              ))
            )}
          </WorkspacePageContainer>
        </ScrollArea>
      </div>
    </SidebarInset>
  );
}

const ProjectGroupSection = memo(function ProjectGroupSection({
  group,
  environmentLabel,
  stopController,
}: {
  readonly group: AgentProcessProjectGroup;
  readonly environmentLabel: string | null;
  readonly stopController: StopAgentProcessController;
}) {
  return (
    <section className="flex min-w-0 flex-col gap-3">
      <h2 className="min-w-0 truncate text-sm font-medium text-foreground">
        {environmentLabel === null ? null : (
          <span className="font-normal text-muted-foreground">{environmentLabel} · </span>
        )}
        {group.title}
      </h2>
      {group.threads.map((thread) => (
        <ThreadGroupSection key={thread.key} thread={thread} stopController={stopController} />
      ))}
    </section>
  );
});

const ThreadGroupSection = memo(function ThreadGroupSection({
  thread,
  stopController,
}: {
  readonly thread: AgentProcessThreadGroup;
  readonly stopController: StopAgentProcessController;
}) {
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <div className="flex min-w-0 items-baseline gap-2">
        {thread.threadId === null ? (
          <span className="min-w-0 truncate text-xs text-muted-foreground">{thread.title}</span>
        ) : (
          <Link
            className="min-w-0 truncate rounded-sm text-xs text-muted-foreground outline-hidden ring-ring hover:text-foreground hover:underline focus-visible:ring-2"
            params={{ environmentId: thread.environmentId, threadId: thread.threadId }}
            to="/$environmentId/$threadId"
          >
            {thread.title}
          </Link>
        )}
        {thread.providerSessionId === null ? null : (
          <span className="shrink-0 font-mono text-[10px] text-muted-foreground/70">
            {thread.providerSessionId.slice(0, 8)}
          </span>
        )}
      </div>
      <ul className="flex min-w-0 list-none flex-col gap-1.5">
        {thread.entries.map((entry) => {
          const key = agentProcessStopKey(entry.environmentId, entry.process);
          return (
            <AgentProcessRow
              key={key}
              environmentId={entry.environmentId}
              process={entry.process}
              status={stopController.statuses.get(key) ?? null}
              stop={stopController.stop}
            />
          );
        })}
      </ul>
    </div>
  );
});

const AgentProcessRow = memo(function AgentProcessRow({
  environmentId,
  process,
  status,
  stop,
}: {
  readonly environmentId: EnvironmentId;
  readonly process: AgentProcess;
  readonly status: AgentProcessStopStatus | null;
  readonly stop: StopAgentProcessController["stop"];
}) {
  const command = useMemo(() => shortenCommand(process.command), [process.command]);
  const pending = status?.kind === "pending";

  return (
    <li className="flex min-w-0 flex-col gap-1.5 rounded-md border border-border px-3 py-2">
      <div className="flex min-w-0 items-center gap-2">
        <Tooltip>
          <TooltipTrigger
            render={
              <code className="min-w-0 flex-1 truncate text-left font-mono text-xs text-foreground">
                {command}
              </code>
            }
          />
          <TooltipPopup className="max-w-100 font-mono break-all" side="top">
            {process.command}
          </TooltipPopup>
        </Tooltip>
        <Button
          disabled={pending}
          onClick={() => void stop(environmentId, process)}
          size="xs"
          variant="outline"
        >
          {pending ? "Stopping…" : "Stop"}
        </Button>
      </div>

      <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
        <Badge size="sm" variant={process.orphaned ? "warning" : "secondary"}>
          {process.orphaned ? "session ended" : "session live"}
        </Badge>
        {process.listeningPorts.map((port) => (
          <Badge
            key={port}
            render={
              <a
                href={resolveDiscoveredServerUrl(environmentId, `http://localhost:${port}/`)}
                rel="noreferrer"
                target="_blank"
              />
            }
            size="sm"
            variant="outline"
          >
            localhost:{port}
          </Badge>
        ))}
        <span className="tabular-nums">{formatUptime(process.uptimeMs)}</span>
        {process.cwd === null ? null : (
          <Tooltip>
            <TooltipTrigger
              render={<span className="min-w-0 truncate">{pathBasename(process.cwd)}</span>}
            />
            <TooltipPopup className="max-w-100 break-all" side="top">
              {process.cwd}
            </TooltipPopup>
          </Tooltip>
        )}
        {process.pids.length > 1 ? <span>{process.pids.length} processes</span> : null}
      </div>

      {status?.kind === "survivors" ? (
        <div className="flex min-w-0 flex-wrap items-center gap-2 text-xs text-warning-foreground">
          <span>Still running</span>
          <Button
            onClick={() => void stop(environmentId, process, { force: true })}
            size="xs"
            variant="warning-outline"
          >
            Force stop
          </Button>
        </div>
      ) : null}
      {status?.kind === "error" ? (
        <p className="min-w-0 text-xs text-destructive-foreground">{status.message}</p>
      ) : null}
    </li>
  );
});
