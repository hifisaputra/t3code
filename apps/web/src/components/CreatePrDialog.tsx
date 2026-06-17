import type { EnvironmentId, VcsRef } from "@t3tools/contracts";
import { CheckIcon, GitBranchIcon, SearchIcon } from "lucide-react";
import { useDeferredValue, useEffect, useMemo, useState } from "react";

import { useVcsRefs } from "../lib/vcsRefState";
import { cn } from "../lib/utils";
import { Button } from "./ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "./ui/dialog";
import { Input } from "./ui/input";
import { ScrollArea } from "./ui/scroll-area";

interface CreatePrDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  environmentId: EnvironmentId | null;
  cwd: string | null;
  /** Branch the pull request is created from. */
  headBranch: string | null;
  /** Lowercased terminology, e.g. "pull request" or "merge request". */
  changeRequestLabel: string;
  onConfirm: (baseBranch: string) => void;
}

const EMPTY_REFS: ReadonlyArray<VcsRef> = [];

export function CreatePrDialog({
  open,
  onOpenChange,
  environmentId,
  cwd,
  headBranch,
  changeRequestLabel,
  onConfirm,
}: CreatePrDialogProps) {
  const [query, setQuery] = useState("");
  const deferredQuery = useDeferredValue(query.trim());
  const [selectedBase, setSelectedBase] = useState<string | null>(null);

  const refTarget = useMemo(
    () => ({ environmentId, cwd, query: deferredQuery }),
    [cwd, deferredQuery, environmentId],
  );
  const refState = useVcsRefs(refTarget);
  const refs = refState.data?.refs ?? EMPTY_REFS;

  // Candidate base branches: every ref except the branch we're merging from.
  // De-duplicate by display name (a branch may exist both locally and on a remote).
  const candidates = useMemo(() => {
    const seen = new Set<string>();
    const result: VcsRef[] = [];
    for (const ref of refs) {
      if (ref.name === headBranch || seen.has(ref.name)) continue;
      seen.add(ref.name);
      result.push(ref);
    }
    return result;
  }, [refs, headBranch]);

  const defaultBase = useMemo(
    () => candidates.find((ref) => ref.isDefault)?.name ?? null,
    [candidates],
  );

  // Reset when closed; preselect the repo's default branch once it loads.
  useEffect(() => {
    if (!open) {
      setSelectedBase(null);
      setQuery("");
    }
  }, [open]);
  useEffect(() => {
    if (open && selectedBase === null && defaultBase !== null) {
      setSelectedBase(defaultBase);
    }
  }, [open, selectedBase, defaultBase]);

  const isLoading = refState.isPending && refState.data === null;
  const canConfirm = selectedBase !== null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPopup className="max-w-md">
        <DialogHeader>
          <DialogTitle>Create {changeRequestLabel}</DialogTitle>
          <DialogDescription>
            {headBranch
              ? `Merge ${headBranch} into the branch you select below.`
              : `Select the branch to merge into.`}
          </DialogDescription>
        </DialogHeader>
        <DialogPanel className="space-y-3">
          <div className="relative">
            <SearchIcon
              aria-hidden="true"
              className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground/55"
            />
            <Input
              autoFocus
              className="ps-8"
              placeholder="Search branches..."
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
          </div>
          <ScrollArea className="h-56 rounded-md border border-input bg-background">
            <div className="space-y-0.5 p-1">
              {isLoading ? (
                <p className="px-2 py-1.5 text-xs text-muted-foreground">Loading branches...</p>
              ) : candidates.length === 0 ? (
                <p className="px-2 py-1.5 text-xs text-muted-foreground">No branches found.</p>
              ) : (
                candidates.map((ref) => {
                  const isSelected = ref.name === selectedBase;
                  const badge = ref.isDefault ? "default" : ref.isRemote ? "remote" : null;
                  return (
                    <button
                      key={`${ref.isRemote ? "r:" : "l:"}${ref.name}`}
                      type="button"
                      className={cn(
                        "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm transition-colors hover:bg-accent/50",
                        isSelected && "bg-accent",
                      )}
                      onClick={() => setSelectedBase(ref.name)}
                    >
                      <GitBranchIcon className="size-3.5 shrink-0 text-muted-foreground" />
                      <span className="min-w-0 flex-1 truncate">{ref.name}</span>
                      {badge && (
                        <span className="shrink-0 text-[10px] text-muted-foreground/45">
                          {badge}
                        </span>
                      )}
                      {isSelected && <CheckIcon className="size-3.5 shrink-0 text-foreground" />}
                    </button>
                  );
                })
              )}
            </div>
          </ScrollArea>
        </DialogPanel>
        <DialogFooter>
          <Button variant="outline" size="sm" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            size="sm"
            disabled={!canConfirm}
            onClick={() => {
              if (!selectedBase) return;
              onConfirm(selectedBase);
            }}
          >
            Create {changeRequestLabel}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
