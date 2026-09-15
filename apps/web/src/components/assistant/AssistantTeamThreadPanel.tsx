import { assistantTeamThread, type EnvironmentId, type ThreadId } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";

import { developerAssistant } from "~/state/developerAssistant";
import { useEnvironmentQuery } from "~/state/query";
import { buildThreadRouteParams } from "~/threadRoutes";

import { Button } from "../ui/button";
import { describeTaskPhase, taskIsFinished, taskOutcome } from "./assistantBoard.logic";
import { teamHolder, TeamThreads, useTeamShells } from "./AssistantTeam";
import { IssueLink, threadIsBusy } from "./assistantUi";
import { THREAD_KIND, ThreadKindIcon } from "./threadKinds";

/**
 * A slim bar over one of an issue's team threads: which issue it belongs to,
 * which of the four conversations this is, where the issue stands, and the way
 * to its teammates and back to the board.
 */
export function AssistantTeamThreadPanel({
  environmentId,
  threadId,
}: {
  environmentId: EnvironmentId;
  threadId: ThreadId;
}) {
  const navigate = useNavigate();
  const board = useEnvironmentQuery(developerAssistant.board({ environmentId, input: {} }));
  const team = assistantTeamThread(threadId);
  const task = team ? (board.data?.tasks.find((t) => t.id === team.taskId) ?? null) : null;
  const shells = useTeamShells(environmentId, task);
  if (!team || !task) return null;

  const role = team.role;
  const kind = THREAD_KIND[role];
  const holder = teamHolder(task, shells);
  const phase = taskIsFinished(task)
    ? taskOutcome(task).label
    : describeTaskPhase({
        task,
        workerBusy: threadIsBusy(holder),
        workerNeedsInput: Boolean(holder?.hasPendingApprovals || holder?.hasPendingUserInput),
        step: holder?.planProgress?.step ?? null,
        hasOpenDecision:
          board.data?.decisions.some((d) => d.answer === null && d.taskId === task.id) ?? false,
      }).label;
  const openThread = (next: ThreadId) =>
    void navigate({
      to: "/$environmentId/$threadId",
      params: buildThreadRouteParams({ environmentId, threadId: next }),
    });

  return (
    <div className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1.5 border-b bg-muted/30 px-4 py-2 sm:px-5">
      <span className="flex min-w-0 flex-1 basis-64 items-center gap-2 text-sm">
        <IssueLink issue={task.issue} />
        <span className="min-w-0 truncate font-medium">{task.issue.title}</span>
        <span className="hidden shrink-0 items-center gap-1 text-muted-foreground sm:flex">
          <span aria-hidden>·</span>
          <ThreadKindIcon kind={role} />
          You are reading the {kind.label.toLowerCase()} thread
        </span>
        <span className="shrink-0 text-muted-foreground">· {phase}</span>
      </span>
      <TeamThreads
        size="sm"
        environmentId={environmentId}
        task={task}
        board={board.data}
        current={role}
        onOpenThread={openThread}
      />
      <Button
        size="xs"
        variant="ghost"
        onClick={() => void navigate({ to: "/assistant", search: { environment: environmentId } })}
      >
        Assistant board
      </Button>
    </div>
  );
}
