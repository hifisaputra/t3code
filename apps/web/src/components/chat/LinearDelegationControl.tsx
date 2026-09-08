import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { useState } from "react";
import { linearEnvironment } from "~/state/linear";
import { useEnvironmentQuery } from "~/state/query";
import { useAtomCommand } from "~/state/use-atom-command";
import { Button } from "../ui/button";

export function LinearDelegationControl({
  environmentId,
  threadId,
}: {
  environmentId: EnvironmentId | null;
  threadId: ThreadId;
}) {
  const status = useEnvironmentQuery(
    environmentId
      ? linearEnvironment.delegationStatus({ environmentId, input: { threadId } })
      : null,
  );
  const stop = useAtomCommand(linearEnvironment.delegationStop);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  if (!status.data?.active || !environmentId) return null;
  return (
    <Button
      size="sm"
      variant="outline"
      disabled={busy}
      title={
        failed
          ? "Could not stop delegation. Try again."
          : "Stop accepting Linear replies for this thread and interrupt the current turn."
      }
      onClick={async () => {
        setBusy(true);
        try {
          const result = await stop({ environmentId, input: { threadId } });
          setFailed(result._tag !== "Success");
          status.refresh();
        } finally {
          setBusy(false);
        }
      }}
    >
      {failed ? "Retry stop delegation" : "Stop delegation"}
    </Button>
  );
}
