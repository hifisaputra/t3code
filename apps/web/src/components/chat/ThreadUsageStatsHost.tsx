import { ThreadUsageStatsDialog } from "./ThreadUsageStatsDialog";
import { closeThreadUsageStats, useThreadUsageStatsStore } from "./threadUsageStatsStore";

/**
 * Mounts the thread usage panel once for the whole app, so any thread menu can
 * open it without owning dialog state.
 */
export function ThreadUsageStatsHost() {
  const target = useThreadUsageStatsStore((state) => state.target);
  if (!target) return null;
  return (
    <ThreadUsageStatsDialog
      environmentId={target.environmentId}
      threadId={target.threadId}
      open
      onOpenChange={(open) => {
        if (!open) closeThreadUsageStats();
      }}
    />
  );
}
