import { createDeveloperAssistantAtoms } from "@t3tools/client-runtime/state/developerAssistant";
import { connectionAtomRuntime } from "../connection/runtime";

export const developerAssistant = createDeveloperAssistantAtoms(connectionAtomRuntime);
