import type { AssistantTaskSummary, EnvironmentId } from "@t3tools/contracts";

import { developerAssistant } from "~/state/developerAssistant";
import { useEnvironmentQuery } from "~/state/query";

/**
 * One issue with the long-form text and evidence the board leaves out, for the
 * person who opened it. Nothing is requested until an issue is open, and the
 * request is repeated only when the board says the issue changed.
 *
 * A server from before the detail request sends the whole issue on the board;
 * `brief` being there is what says so, and then nothing is asked for. Either
 * way the caller reads one task whose optional text is filled in when it can be.
 */
export function useAssistantTaskDetail(
  environmentId: EnvironmentId,
  task: AssistantTaskSummary | null,
): { task: AssistantTaskSummary | null; isPending: boolean; error: string | null } {
  const wanted = task !== null && task.brief === undefined ? task.id : null;
  const query = useEnvironmentQuery(
    wanted === null
      ? null
      : developerAssistant.taskDetail({ environmentId, input: { taskId: wanted } }),
  );
  if (task === null) return { task: null, isPending: false, error: null };
  if (wanted === null) return { task, isPending: false, error: null };
  return {
    // The board's summary carries the whole row while the rest is on its way,
    // so opening an issue never shows an empty page.
    task: query.data ?? task,
    isPending: query.data === null && query.error === null,
    error: query.error,
  };
}
