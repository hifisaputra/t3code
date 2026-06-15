import { useNavigate, useParams } from "@tanstack/react-router";
import { DiffIcon, FilesIcon } from "lucide-react";

import { stripDiffSearchParams } from "../diffRouteSearch";
import { stripFilesSearchParams } from "../filesRouteSearch";
import { buildThreadRouteParams, resolveThreadRouteRef } from "../threadRoutes";
import { Toggle, ToggleGroup } from "./ui/toggle-group";

export type RightPanelTab = "diff" | "files";

/**
 * Segmented switcher shared by the diff and file-browser panels. Switching tabs
 * swaps the active right-panel route param (`diff` / `files`) while clearing the
 * other tab's params so only one panel occupies the shared slot at a time.
 */
export function RightPanelTabs({ active }: { active: RightPanelTab }) {
  const navigate = useNavigate();
  const threadRef = useParams({
    strict: false,
    select: (params) => resolveThreadRouteRef(params),
  });

  const switchTo = (tab: RightPanelTab) => {
    if (!threadRef || tab === active) {
      return;
    }
    void navigate({
      to: "/$environmentId/$threadId",
      params: buildThreadRouteParams(threadRef),
      replace: true,
      search: (previous) =>
        tab === "files"
          ? { ...stripDiffSearchParams(previous), files: "1" }
          : { ...stripFilesSearchParams(previous), diff: "1" },
    });
  };

  return (
    <ToggleGroup
      className="shrink-0 [-webkit-app-region:no-drag]"
      variant="outline"
      size="xs"
      value={[active]}
      onValueChange={(value) => {
        const next = value[0];
        if (next === "diff" || next === "files") {
          switchTo(next);
        }
      }}
    >
      <Toggle aria-label="Show diff" value="diff">
        <DiffIcon className="size-3" />
        <span className="text-[11px] leading-none max-sm:hidden">Diff</span>
      </Toggle>
      <Toggle aria-label="Show files" value="files">
        <FilesIcon className="size-3" />
        <span className="text-[11px] leading-none max-sm:hidden">Files</span>
      </Toggle>
    </ToggleGroup>
  );
}
