import type { ProviderInstanceId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import { ProviderInstanceRegistry } from "./ProviderInstanceRegistry.ts";

/**
 * Workspace-specific web configuration of a provider instance, or an explicit
 * explanation when it cannot be checked. The developer assistant puts this text
 * in a research lead's prompt, so it never claims access it did not verify.
 * Never starts a provider session.
 */
export const getResearchAccess = Effect.fn("ProviderResearchAccess.getResearchAccess")(function* (
  instanceId: ProviderInstanceId,
  cwd: string,
) {
  const registry = yield* ProviderInstanceRegistry;
  const instance = yield* registry.getInstance(instanceId);
  if (instance === undefined) {
    return `Provider instance ${instanceId} is not available; its web access cannot be checked. Check available tools before taking research, or ask the person.`;
  }
  if (!instance.enabled) return `Provider instance ${instanceId} is disabled; it cannot research.`;
  return instance.researchAccess
    ? yield* instance.researchAccess(cwd)
    : `Native web access is unverified for ${instanceId} (${instance.driverKind}): this provider does not expose a workspace web-configuration probe. Check its configured tools and permissions before taking research; do not infer access from the provider name.`;
});
