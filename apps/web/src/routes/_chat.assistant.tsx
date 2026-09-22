import { createFileRoute } from "@tanstack/react-router";
import { EnvironmentId } from "@t3tools/contracts";
import { DeveloperAssistantPage } from "../components/assistant/DeveloperAssistantPage";

/** `review` is the issue being read: the board is what the page shows without one. */
export const Route = createFileRoute("/_chat/assistant")({
  component: DeveloperAssistantPage,
  validateSearch: (
    raw: Record<string, unknown>,
  ): { environment?: EnvironmentId; review?: string } => ({
    ...(typeof raw.environment === "string" && raw.environment
      ? { environment: EnvironmentId.make(raw.environment) }
      : {}),
    ...(typeof raw.review === "string" && raw.review ? { review: raw.review } : {}),
  }),
});
