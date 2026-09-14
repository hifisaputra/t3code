import {
  assistantTaskHoldsProject,
  type AssistantProject,
  type AssistantTask,
  type EnvironmentId,
} from "@t3tools/contracts";
import { SendIcon } from "lucide-react";
import { useState } from "react";

import { developerAssistant } from "~/state/developerAssistant";
import { useProjects } from "~/state/entities";
import { useEnvironmentQuery } from "~/state/query";
import { useAtomCommand } from "~/state/use-atom-command";

import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Input } from "../ui/input";
import { Spinner } from "../ui/spinner";
import { Textarea } from "../ui/textarea";
import { useAssistantAction } from "./assistantUi";

/** When a dispatched issue would start, given what the project is doing now. */
export function dispatchTiming(project: AssistantProject, activeTask: AssistantTask | null) {
  if (project.status === "stopped")
    return "The assistant is stopped, so the issue waits until you start it or resume the teams.";
  if (activeTask)
    return `A team starts on it once ${activeTask.issue.identifier} is done, ahead of the loop's own picks.`;
  return "A team starts on it right away.";
}

/**
 * Give one issue to the next team. With `reference` the issue is already
 * chosen, as from the issue page; otherwise the person names it.
 */
export function AssistantDispatchDialog({
  environmentId,
  project,
  activeTask,
  title,
  reference: chosen,
  open,
  onOpenChange,
}: {
  environmentId: EnvironmentId;
  project: AssistantProject;
  activeTask: AssistantTask | null;
  title: string;
  reference?: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const dispatch = useAtomCommand(developerAssistant.dispatch);
  const { pending, run } = useAssistantAction();
  const [typed, setTyped] = useState("");
  const [note, setNote] = useState("");
  const reference = (chosen ?? typed).trim();
  const busy = pending !== null;

  const submit = async () => {
    if (!reference) return;
    const ok = await run(
      "dispatch",
      () =>
        dispatch({
          environmentId,
          input: { projectId: project.config.projectId, reference, note: note.trim() },
        }),
      { failure: `Could not dispatch ${reference}`, success: `${reference} dispatched to a team` },
    );
    if (ok) onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={(next) => !busy && onOpenChange(next)}>
      <DialogPopup className="max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <SendIcon className="size-4" />
            {chosen ? `Dispatch ${chosen} to a team` : "Dispatch an issue to a team"}
          </DialogTitle>
          <DialogDescription>
            A team leader, a worker, a code reviewer and an e2e tester take it to staging in {title}
            . The leader takes the issue or asks you; it does not decline an issue you picked.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel className="grid gap-4">
          {chosen ? null : (
            <label className="grid gap-1.5">
              <span className="font-medium text-sm">Issue</span>
              <Input
                autoFocus
                value={typed}
                disabled={busy}
                onChange={(event) => setTyped(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") void submit();
                }}
                placeholder="SPI-123 or a Linear link"
                aria-label="Issue to dispatch"
              />
            </label>
          )}
          <label className="grid gap-1.5">
            <span className="font-medium text-sm">Note for the team leader</span>
            <Textarea
              value={note}
              maxLength={20000}
              disabled={busy}
              onChange={(event) => setNote(event.target.value)}
              placeholder="Optional. What you want from it, or what to do first."
              className="[&_textarea]:min-h-20"
            />
          </label>
        </DialogPanel>
        <DialogFooter className="items-center">
          <p className="min-w-0 flex-1 text-muted-foreground text-xs">
            {dispatchTiming(project, activeTask)}
          </p>
          <Button variant="outline" size="sm" disabled={busy} onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button size="sm" disabled={busy || !reference} onClick={() => void submit()}>
            {busy ? <Spinner className="size-3.5" /> : <SendIcon />}
            Dispatch team
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

/**
 * Dispatch from an issue's own page. Shown only when an assistant covers the
 * issue's Linear project and no team has it yet.
 */
export function AssistantDispatchButton({
  environmentId,
  identifier,
  linearProjectId,
}: {
  environmentId: EnvironmentId;
  identifier: string;
  linearProjectId: string | null;
}) {
  const [open, setOpen] = useState(false);
  const projects = useProjects();
  const board = useEnvironmentQuery(
    linearProjectId ? developerAssistant.board({ environmentId, input: {} }) : null,
  );
  const project = board.data?.projects.find((p) => p.config.linearProjectId === linearProjectId);
  if (!project || !board.data) return null;
  const projectId = project.config.projectId;
  const tasks = board.data.tasks.filter((t) => t.projectId === projectId);
  const forIssue = tasks.filter((t) => t.issue.identifier === identifier);
  const claimed = forIssue.some(
    (t) => t.status === "queued" || assistantTaskHoldsProject(t.status),
  );
  if (claimed) return null;
  // The server refuses to dispatch an issue whose last run is waiting on the
  // person, so say what to do instead of offering a button that fails.
  const latest = forIssue.toSorted((a, b) => a.updatedAt.localeCompare(b.updatedAt)).at(-1);
  if (latest?.status === "review")
    return (
      <span className="text-muted-foreground text-xs">
        Waiting for your review. Accept it or request changes to dispatch it again.
      </span>
    );
  const activeTask = tasks.find((t) => assistantTaskHoldsProject(t.status)) ?? null;
  return (
    <>
      <Button type="button" size="sm" variant="outline" onClick={() => setOpen(true)}>
        <SendIcon aria-hidden />
        Dispatch team
      </Button>
      {open ? (
        <AssistantDispatchDialog
          environmentId={environmentId}
          project={project}
          activeTask={activeTask}
          title={
            projects.find((p) => p.environmentId === environmentId && p.id === projectId)?.title ??
            "this project"
          }
          reference={identifier}
          open
          onOpenChange={setOpen}
        />
      ) : null}
    </>
  );
}
