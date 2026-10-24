import type { ScopedThreadRef } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { ActivityIcon } from "lucide-react";

import { useThreadAgentProcesses } from "../../state/agentProcesses";
import { collectListeningPorts, formatPortSummary } from "../processes/agentProcessesModel";
import { agentProcessStopKey, useStopAgentProcess } from "../processes/useStopAgentProcess";
import { Button } from "../ui/button";
import type { ComposerBannerStackItem } from "./ComposerBannerStack";

/**
 * Dev servers and watchers a thread started and never stopped. Reads the same
 * pushed snapshot as the Processes page, so the banner costs no extra server
 * work and disappears on its own once the chains are gone.
 */
export function useAgentProcessesBanner(
  threadRef: ScopedThreadRef | null,
): ComposerBannerStackItem | null {
  const navigate = useNavigate();
  const processes = useThreadAgentProcesses(threadRef);
  const { statuses, stop } = useStopAgentProcess();
  if (threadRef === null || processes.length === 0) return null;
  const { environmentId } = threadRef;
  const stopping = processes.some(
    (process) => statuses.get(agentProcessStopKey(environmentId, process))?.kind === "pending",
  );
  const stopAll = async () => {
    // One at a time: each stop signals a whole process group and waits out a
    // grace period on the server, so firing them together only buys races.
    for (const process of processes) {
      await stop(environmentId, process);
    }
  };
  const count = processes.length;
  return {
    id: `agent-processes:${threadRef.threadId}`,
    variant: "info",
    icon: <ActivityIcon />,
    title: `${count} ${count === 1 ? "process" : "processes"} still running from this thread`,
    description: formatPortSummary(collectListeningPorts(processes)),
    actions: (
      <>
        <Button size="xs" variant="ghost" disabled={stopping} onClick={() => void stopAll()}>
          {stopping ? "Stopping..." : "Stop"}
        </Button>
        <Button size="xs" variant="ghost" onClick={() => void navigate({ to: "/processes" })}>
          View
        </Button>
      </>
    ),
  };
}
