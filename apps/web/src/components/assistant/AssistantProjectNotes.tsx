import {
  ASSISTANT_PROJECT_NOTES,
  type AssistantProject,
  type EnvironmentId,
} from "@t3tools/contracts";
import { PlusIcon, XIcon } from "lucide-react";
import { useState } from "react";

import { developerAssistant } from "~/state/developerAssistant";
import { useAtomCommand } from "~/state/use-atom-command";
import { formatRelativeTimeLabel } from "~/timestampFormat";

import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Spinner } from "../ui/spinner";
import { projectNoteSource } from "./assistantBoard.logic";
import { confirmDestructive, useAssistantAction } from "./assistantUi";

/**
 * Facts the project's teams wrote down for later teams, which every team's first
 * message lists until a setup revision folds them into the instructions. The
 * person deletes the ones that are wrong or adds their own.
 */
export function AssistantProjectNotes({
  environmentId,
  project,
}: {
  environmentId: EnvironmentId;
  project: AssistantProject;
}) {
  const addNote = useAtomCommand(developerAssistant.addProjectNote);
  const deleteNote = useAtomCommand(developerAssistant.deleteProjectNote);
  const { pending, run } = useAssistantAction();
  const [text, setText] = useState("");
  const notes = project.notes ?? [];
  const projectId = project.config.projectId;
  const full = notes.length >= ASSISTANT_PROJECT_NOTES.maxOpen;
  const trimmed = text.trim();

  const submit = async () => {
    if (!trimmed || full || pending !== null) return;
    const added = await run(
      "add",
      () => addNote({ environmentId, input: { projectId, text: trimmed } }),
      { failure: "Could not add the note" },
    );
    if (added) setText("");
  };

  return (
    <div className="flex flex-col gap-2">
      <p className="-mt-1 text-muted-foreground text-xs">
        What teams found out about the project for the teams after them. Every team&apos;s first
        message lists these until a setup revision folds them into the instructions.
      </p>
      {notes.length > 0 ? (
        <ul className="-mx-2 flex flex-col">
          {notes.map((note) => (
            <li
              key={note.id}
              className="grid grid-cols-[minmax(0,1fr)_auto] items-start gap-2.5 rounded-lg px-2 py-1.5 text-sm"
            >
              <div className="min-w-0">
                <p className="break-words">{note.text}</p>
                <p className="mt-0.5 text-muted-foreground text-xs">
                  {projectNoteSource(note)} · {formatRelativeTimeLabel(note.createdAt)}
                </p>
              </div>
              <Button
                size="icon-xs"
                variant="ghost"
                aria-label="Delete this note"
                disabled={pending !== null}
                onClick={async () => {
                  const confirmed = await confirmDestructive(
                    `Delete this note?\n${note.text}\nLater teams will no longer see it.`,
                  );
                  if (!confirmed) return;
                  void run(
                    note.id,
                    () => deleteNote({ environmentId, input: { noteId: note.id } }),
                    {
                      failure: "Could not delete the note",
                    },
                  );
                }}
              >
                {pending === note.id ? <Spinner className="size-3.5" /> : <XIcon />}
              </Button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-muted-foreground text-sm">No notes yet.</p>
      )}
      <div className="flex items-center gap-2">
        <Input
          size="sm"
          value={text}
          maxLength={ASSISTANT_PROJECT_NOTES.maxLength}
          disabled={full || pending === "add"}
          onChange={(event) => setText(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") void submit();
          }}
          placeholder={
            full
              ? `${ASSISTANT_PROJECT_NOTES.maxOpen} notes is the most a project keeps. Delete one first.`
              : "A fact later teams need, such as what staging cannot show"
          }
          aria-label="New project note"
        />
        <Button
          size="sm"
          variant="outline"
          disabled={!trimmed || full || pending !== null}
          onClick={() => void submit()}
        >
          {pending === "add" ? <Spinner className="size-3.5" /> : <PlusIcon />}
          Add
        </Button>
      </div>
    </div>
  );
}
