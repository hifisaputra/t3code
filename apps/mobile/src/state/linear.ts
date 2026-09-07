import { createLinearEnvironmentAtoms } from "@t3tools/client-runtime/state/linear";

import { connectionAtomRuntime } from "../connection/runtime";

/**
 * Linear reads for this client. The server holds the key and makes every call,
 * so these atoms only ever carry an environment id and an issue reference.
 */
export const linearEnvironment = createLinearEnvironmentAtoms(connectionAtomRuntime);
