import { createFileRoute } from "@tanstack/react-router";

import { AgentProcessesPage } from "../components/processes/AgentProcessesPage";

export const Route = createFileRoute("/processes")({
  component: AgentProcessesPage,
});
