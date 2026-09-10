import { CalendarIcon } from "lucide-react";
import { useId, useState } from "react";
import { cn } from "~/lib/utils";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import { Input } from "../ui/input";
import {
  Popover,
  PopoverDescription,
  PopoverPopup,
  PopoverTitle,
  PopoverTrigger,
} from "../ui/popover";

export interface CalendarPickerOption {
  id: string;
  title: string;
  shown: boolean;
  /** Busy events on this calendar warn before a block is saved over them. */
  conflicts: boolean;
  /** The scheduling calendar cannot be hidden. */
  scheduling: boolean;
  writable: boolean;
  /** A dot class from `calendarColorDotClass`, so the row matches the block in the grid. */
  color: string;
}

/** Past this many calendars a search box earns its row. */
const SEARCHABLE_FROM = 8;

/**
 * One place to say which calendars the week shows and which of those count
 * for overlap warnings. Two checkboxes per row replace two separate menus
 * whose relationship (conflicts are a subset of shown) was easy to miss.
 */
export function CalendarPickerPopover({
  options,
  disabled,
  onShown,
  onConflicts,
}: {
  options: readonly CalendarPickerOption[];
  disabled: boolean;
  onShown: (id: string, shown: boolean) => void;
  onConflicts: (id: string, conflicts: boolean) => void;
}) {
  const fieldId = useId();
  const [search, setSearch] = useState("");
  const visible = options.filter((option) =>
    option.title.toLocaleLowerCase().includes(search.trim().toLocaleLowerCase()),
  );
  const shownCount = options.filter((option) => option.shown).length;
  return (
    <Popover
      onOpenChange={(open) => {
        if (!open) setSearch("");
      }}
    >
      <PopoverTrigger render={<Button size="sm" variant="outline" disabled={disabled} />}>
        <CalendarIcon aria-hidden className="size-3.5" />
        Calendars
        <Badge size="sm" variant="secondary" className="tabular-nums">
          {shownCount}
        </Badge>
      </PopoverTrigger>
      <PopoverPopup align="end" className="w-88 max-w-[calc(100vw-2rem)]" viewportClassName="p-3">
        <PopoverTitle className="text-sm font-medium">Calendars</PopoverTitle>
        <PopoverDescription className="mt-1 text-xs text-muted-foreground">
          Shown calendars appear in the week. Busy events on calendars checked for conflicts warn
          before you save over them.
        </PopoverDescription>
        {options.length > SEARCHABLE_FROM ? (
          <Input
            className="mt-2"
            size="sm"
            aria-label="Search calendars"
            placeholder="Search calendars…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        ) : null}
        <div
          className="mt-2 grid grid-cols-[minmax(0,1fr)_3rem_4.25rem] items-center px-2 text-[11px] font-medium uppercase tracking-wide text-muted-foreground"
          aria-hidden
        >
          <span>Calendar</span>
          <span className="text-center">Show</span>
          <span className="text-center">Conflicts</span>
        </div>
        <div className="mt-1 max-h-64 space-y-0.5 overflow-y-auto">
          {visible.map((option) => {
            const showId = `${fieldId}:${option.id}:show`;
            const conflictId = `${fieldId}:${option.id}:conflicts`;
            return (
              <div
                key={option.id}
                className="grid grid-cols-[minmax(0,1fr)_3rem_4.25rem] items-center rounded-md px-2 py-1.5 text-sm transition-colors hover:bg-accent/60"
              >
                <label htmlFor={showId} className="flex min-w-0 cursor-pointer items-center gap-2">
                  <span
                    aria-hidden
                    className={cn("size-2.5 shrink-0 rounded-full", option.color)}
                  />
                  <span className="min-w-0">
                    <span className="block truncate">{option.title}</span>
                    {option.scheduling || !option.writable ? (
                      <span className="block truncate text-xs text-muted-foreground">
                        {option.scheduling ? "Scheduling calendar" : "Read only"}
                      </span>
                    ) : null}
                  </span>
                </label>
                <span className="flex justify-center">
                  <Checkbox
                    id={showId}
                    aria-label={`Show ${option.title}`}
                    checked={option.shown}
                    disabled={disabled || option.scheduling}
                    onCheckedChange={(next) => onShown(option.id, next)}
                  />
                </span>
                <span className="flex justify-center">
                  <Checkbox
                    id={conflictId}
                    aria-label={`Check ${option.title} for conflicts`}
                    checked={option.shown && option.conflicts}
                    disabled={disabled || !option.shown}
                    onCheckedChange={(next) => onConflicts(option.id, next)}
                  />
                </span>
              </div>
            );
          })}
          {!visible.length ? (
            <p className="px-2 py-1.5 text-xs text-muted-foreground">No calendars found.</p>
          ) : null}
        </div>
      </PopoverPopup>
    </Popover>
  );
}
