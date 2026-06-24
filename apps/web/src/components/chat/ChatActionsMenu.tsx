import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId, ProjectActionDefinition } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { AsyncResult } from "effect/unstable/reactivity";
import { PlayIcon, TerminalIcon } from "lucide-react";

import { projectEnvironment } from "~/state/projects";
import { Button } from "../ui/button";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../ui/menu";

interface ChatActionsMenuProps {
  environmentId: EnvironmentId;
  /** Workspace root used to look up `.t3code/actions.json`. */
  cwd: string;
  onRunAction: (action: ProjectActionDefinition) => void;
}

/**
 * Dropdown of repo-defined shell actions declared in `.t3code/actions.json`.
 * Renders nothing when the project declares no actions.
 */
export function ChatActionsMenu({ environmentId, cwd, onRunAction }: ChatActionsMenuProps) {
  const result = useAtomValue(projectEnvironment.listActions({ environmentId, input: { cwd } }));
  const actions = Option.getOrNull(AsyncResult.value(result))?.actions ?? [];

  if (actions.length === 0) {
    return null;
  }

  return (
    <Menu highlightItemOnHover={false}>
      <MenuTrigger
        render={
          <Button size="xs" variant="outline" aria-label="Run a project action">
            <TerminalIcon className="size-3.5" />
            Actions
          </Button>
        }
      />
      <MenuPopup align="end">
        {actions.map((action, index) => (
          <MenuItem
            key={`${action.label}:${index}`}
            onClick={() => onRunAction(action)}
            className="group flex items-center gap-2"
          >
            <PlayIcon className="size-3.5 text-muted-foreground" />
            <span className="min-w-0 flex-1 truncate">{action.label}</span>
          </MenuItem>
        ))}
      </MenuPopup>
    </Menu>
  );
}

export default ChatActionsMenu;
