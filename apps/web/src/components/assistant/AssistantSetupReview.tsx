import { useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import type { AssistantSetup, EnvironmentId, ThreadId } from "@t3tools/contracts";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { developerAssistant } from "../../state/developerAssistant";
import { useEnvironmentQuery } from "../../state/query";
import { useThreadShell } from "../../state/entities";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";

export function AssistantSetupReview({
  setup,
  environmentId,
  onResolved,
}: {
  setup: AssistantSetup;
  environmentId: EnvironmentId;
  onResolved?: () => void;
}) {
  const resolve = useAtomCommand(developerAssistant.resolveSetup);
  const thread = useThreadShell({ environmentId, threadId: setup.threadId });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const proposal = setup.proposal;
  const working =
    thread?.session?.status === "running" ||
    thread?.session?.status === "starting" ||
    thread?.latestTurn?.state === "running" ||
    thread?.backgroundLiveness != null ||
    thread?.hasPendingApprovals ||
    thread?.hasPendingUserInput;
  const act = async (action: "save" | "cancel") => {
    setBusy(true);
    setError(null);
    try {
      const result = await resolve({
        environmentId,
        input: { threadId: setup.threadId, revision: setup.revision, action },
      });
      if (result._tag === "Failure") setError(String(squashAtomCommandFailure(result)));
      else if (result._tag === "Success") onResolved?.();
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="space-y-4 text-sm">
      {proposal ? (
        <>
          <p className="whitespace-pre-wrap">{setup.summary}</p>
          <dl className="grid grid-cols-[auto_1fr] gap-x-5 gap-y-2">
            <dt className="text-muted-foreground">Integration branch</dt>
            <dd>{proposal.baseBranch}</dd>
            <dt className="text-muted-foreground">Staging</dt>
            <dd className="break-all">{proposal.stagingUrl ?? "Reported by the project check"}</dd>
            <dt className="text-muted-foreground">Issue scope</dt>
            <dd>
              {proposal.assignedToMe ? "Assigned to your Linear account" : "All assignees"} ·{" "}
              {proposal.readyStates.join(", ") || "Unstarted issues"}
            </dd>
            <dt className="text-muted-foreground">Models</dt>
            <dd>
              {proposal.modelSelection.model} (assistant)
              <br />
              {proposal.workerModelSelection.model} (coding)
            </dd>
            <dt className="text-muted-foreground">Permissions</dt>
            <dd>
              {proposal.runtimeMode === "full-access"
                ? "Run unattended with full access"
                : "Ask for command approvals"}
            </dd>
            <dt className="text-muted-foreground">Linear states</dt>
            <dd>
              After staging: {proposal.reviewState || "Keep current"}
              <br />
              After acceptance: {proposal.acceptedState || "Keep current"}
            </dd>
            <dt className="text-muted-foreground">Automatic work rounds</dt>
            <dd>{proposal.maxWorkerTurns} per issue</dd>
          </dl>
          {proposal.deploymentTargets?.map((target) => (
            <div key={target.id} className="rounded-md border p-3">
              <p className="font-medium">
                {target.id} · {target.kind === "github-actions" ? "GitHub Actions" : "Railway"}
              </p>
              <p className="mt-1 break-all text-xs text-muted-foreground">
                {target.kind === "github-actions"
                  ? `${target.repository} · ${target.workflow}`
                  : `Project ${target.railwayProjectId} · environment ${target.environmentId} · service ${target.serviceId}`}
              </p>
            </div>
          ))}
          {proposal.stagingCheckCommand && (
            <div className="rounded-md border p-3">
              <p className="font-medium">Custom staging check</p>
              <pre className="mt-2 whitespace-pre-wrap break-all text-xs">
                {proposal.stagingCheckCommand}
              </pre>
              <p className="mt-2 text-xs text-muted-foreground">
                Saving authorizes T3 to run this command at the project root when verifying staging.
              </p>
            </div>
          )}
          <details>
            <summary className="cursor-pointer font-medium">Project instructions</summary>
            <p className="mt-2 whitespace-pre-wrap text-muted-foreground">
              {proposal.instructions}
            </p>
          </details>
          <p className="text-muted-foreground">
            Discuss changes in the conversation. Saving keeps the issue queue stopped until you
            choose Start.
          </p>
        </>
      ) : (
        <p className="text-muted-foreground">
          Your assistant will inspect the project and ask for any missing details here. Its proposed
          setup will appear when it is ready.
        </p>
      )}
      {error && (
        <p role="alert" className="text-destructive">
          {error}
        </p>
      )}
      <div className="flex flex-wrap items-center gap-2">
        {proposal && (
          <Button
            size="sm"
            disabled={busy || !thread || Boolean(working)}
            onClick={() => void act("save")}
          >
            Save setup
          </Button>
        )}
        <Button size="sm" variant="ghost" disabled={busy} onClick={() => void act("cancel")}>
          Cancel setup
        </Button>
        {proposal && working && (
          <span role="status" className="text-xs text-muted-foreground">
            Waiting for the setup turn to finish.
          </span>
        )}
      </div>
    </div>
  );
}

export function AssistantSetupThreadPanel({
  environmentId,
  threadId,
}: {
  environmentId: EnvironmentId;
  threadId: ThreadId;
}) {
  const board = useEnvironmentQuery(developerAssistant.board({ environmentId, input: {} }));
  const setup = board.data?.setups?.find((s) => s.threadId === threadId);
  const navigate = useNavigate();
  if (!setup) return null;
  return (
    <div className="max-h-[45vh] shrink-0 overflow-y-auto border-b bg-muted/20 px-5 py-3">
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <span className="text-sm font-medium">
          {setup.proposal ? "Setup proposal ready" : "Project setup conversation"}
        </span>
        <Button
          size="sm"
          variant="ghost"
          onClick={() =>
            void navigate({ to: "/assistant", search: { environment: environmentId } })
          }
        >
          Developer assistant
        </Button>
      </div>
      <details
        key={setup.proposal ? "proposal" : "discovering"}
        open={setup.proposal ? undefined : true}
      >
        <summary className="cursor-pointer text-sm text-muted-foreground">
          {setup.proposal ? "Review and save setup" : "Setup progress"}
        </summary>
        <div className="pt-3">
          <AssistantSetupReview
            setup={setup}
            environmentId={environmentId}
            onResolved={() =>
              void navigate({ to: "/assistant", search: { environment: environmentId } })
            }
          />
        </div>
      </details>
    </div>
  );
}
