import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { create } from "zustand";

export interface ThreadUsageStatsTarget {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
}

interface ThreadUsageStatsStoreState {
  readonly target: ThreadUsageStatsTarget | null;
  readonly open: (target: ThreadUsageStatsTarget) => void;
  readonly close: () => void;
}

/**
 * A single app-wide slot for the thread usage panel, matching the diagram
 * lightbox: the dialog mounts once at the root so the sidebar row menu and the
 * chat header menu can both open it without threading dialog state through
 * either tree.
 */
export const useThreadUsageStatsStore = create<ThreadUsageStatsStoreState>()((set) => ({
  target: null,
  open: (target) => set({ target }),
  close: () => set({ target: null }),
}));

export function openThreadUsageStats(target: ThreadUsageStatsTarget): void {
  useThreadUsageStatsStore.getState().open(target);
}

export function closeThreadUsageStats(): void {
  useThreadUsageStatsStore.getState().close();
}
