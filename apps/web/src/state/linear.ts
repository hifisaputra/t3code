import { createLinearEnvironmentAtoms } from "@t3tools/client-runtime/state/linear";
import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId, LinearIssueDetail } from "@t3tools/contracts";
import { Atom } from "effect/unstable/reactivity";
import { useLayoutEffect } from "react";

import { connectionAtomRuntime } from "../connection/runtime";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { useEnvironments } from "./environments";

export const linearEnvironment = createLinearEnvironmentAtoms(connectionAtomRuntime);

/**
 * Whether any connected server holds a Linear key.
 *
 * The key never comes back to the client, so the settings value is a redaction
 * marker: a non-empty string is that server saying it has one. Entry points to
 * the issues page use this to stay hidden until Linear is connected somewhere.
 */
export function useAnyEnvironmentHasLinearKey(): boolean {
  const { environments } = useEnvironments();
  return environments.some(
    (environment) => (environment.serverConfig?.settings.linear.apiKey ?? "").length > 0,
  );
}

/**
 * The last issue anybody read, kept per identifier outside React.
 *
 * A sidebar row that scrolls offscreen drops its live query, and the chip
 * would blink out with it. Mirrors `useSharedPullRequestSummary`: the shared
 * atom is the external system, so the row can publish into it during layout
 * without a render of its own.
 */
const observedLinearIssueAtom = Atom.family((key: string) =>
  Atom.make<LinearIssueDetail | null>(null).pipe(
    Atom.setIdleTTL(5 * 60_000),
    Atom.withLabel(`web-linear:observed-issue:${key}`),
  ),
);

export function useSharedLinearIssue(
  environmentId: EnvironmentId | null,
  identifier: string | null,
  current: LinearIssueDetail | null,
): LinearIssueDetail | null {
  const key =
    environmentId === null || identifier === null ? "none" : `${environmentId}:${identifier}`;
  const atom = observedLinearIssueAtom(key);
  const observed = useAtomValue(atom);
  useLayoutEffect(() => {
    if (environmentId === null || current === null) return;
    appAtomRegistry.modify(atom, (previous) =>
      previous === current ? [false, previous] : [true, current],
    );
  }, [atom, current, environmentId]);
  return current ?? observed;
}
