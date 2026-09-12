import { createFileRoute } from "@tanstack/react-router";
import { DeveloperAssistantPage } from "../components/assistant/DeveloperAssistantPage";

export const Route = createFileRoute("/_chat/assistant")({ component: DeveloperAssistantPage });
