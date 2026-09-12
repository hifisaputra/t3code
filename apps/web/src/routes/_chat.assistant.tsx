import { createFileRoute } from "@tanstack/react-router";
import { EnvironmentId } from "@t3tools/contracts";
import { DeveloperAssistantPage } from "../components/assistant/DeveloperAssistantPage";

export const Route = createFileRoute("/_chat/assistant")({
  component: DeveloperAssistantPage,
  validateSearch: (raw: Record<string, unknown>): { environment?: EnvironmentId } =>
    typeof raw.environment === "string" && raw.environment
      ? { environment: EnvironmentId.make(raw.environment) }
      : {},
});
