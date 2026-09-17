import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type * as SqlClient from "effect/unstable/sql/SqlClient";
import { AssistantProjectNote } from "@t3tools/contracts";

type NoteRow = {
  id: string;
  project_id: string;
  text: string;
  role: string;
  task_id: string | null;
  issue_identifier: string | null;
  created_at: string;
};
const decodeNote = Schema.decodeUnknownEffect(AssistantProjectNote);

/** A project's notes that no setup revision has absorbed yet, oldest first. */
export const openProjectNotes = (sql: SqlClient.SqlClient, projectId: string) =>
  sql<NoteRow>`SELECT id, project_id, text, role, task_id, issue_identifier, created_at
    FROM assistant_project_notes WHERE project_id = ${projectId} AND absorbed_at IS NULL
    ORDER BY created_at, rowid`.pipe(
    Effect.flatMap((rows) =>
      Effect.forEach(rows, (row) =>
        decodeNote({
          id: row.id,
          projectId: row.project_id,
          text: row.text,
          role: row.role,
          taskId: row.task_id,
          issueIdentifier: row.issue_identifier,
          createdAt: row.created_at,
        }),
      ),
    ),
  );

/** Two notes say the same thing when they differ only in case and whitespace. */
export const projectNoteKey = (text: string) => text.trim().replace(/\s+/g, " ").toLowerCase();
