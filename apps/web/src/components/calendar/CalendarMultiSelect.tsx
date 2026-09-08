import { useState } from "react";
import { ChevronDownIcon } from "lucide-react";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import {
  Popover,
  PopoverTrigger,
  PopoverPopup,
  PopoverTitle,
  PopoverDescription,
} from "../ui/popover";

export function CalendarMultiSelect({
  label,
  description,
  options,
  disabled,
  onChange,
}: {
  label: string;
  description: string;
  options: readonly {
    id: string;
    title: string;
    selected: boolean;
    locked?: boolean;
    detail?: string | undefined;
    color?: string | undefined;
  }[];
  disabled: boolean;
  onChange: (id: string, selected: boolean) => void;
}) {
  const [search, setSearch] = useState("");
  const visible = options.filter((option) =>
    option.title.toLocaleLowerCase().includes(search.trim().toLocaleLowerCase()),
  );
  return (
    <Popover
      onOpenChange={(open) => {
        if (!open) setSearch("");
      }}
    >
      <PopoverTrigger render={<Button size="sm" variant="outline" disabled={disabled} />}>
        {label} · {options.filter((option) => option.selected).length}
        <ChevronDownIcon className="size-3.5" />
      </PopoverTrigger>
      <PopoverPopup align="start" className="w-80 max-w-[calc(100vw-2rem)]" viewportClassName="p-3">
        <PopoverTitle className="text-sm">{label}</PopoverTitle>
        <PopoverDescription className="mt-1 text-xs">{description}</PopoverDescription>
        <Input
          className="my-2"
          aria-label={`Search ${label.toLowerCase()}`}
          placeholder="Search calendars…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <div className="max-h-60 space-y-1 overflow-y-auto">
          {visible.map((option) => (
            <label
              key={option.id}
              className="flex items-start gap-2 rounded p-2 text-xs hover:bg-accent"
            >
              <input
                type="checkbox"
                className="mt-0.5"
                checked={option.selected}
                disabled={disabled || option.locked}
                onChange={(e) => onChange(option.id, e.target.checked)}
              />
              {option.color ? (
                <span
                  aria-hidden="true"
                  className={`mt-0.5 size-3 shrink-0 rounded border ${option.color}`}
                />
              ) : null}
              <span className="min-w-0 break-words">
                {option.title}
                {option.detail ? (
                  <span className="block text-muted-foreground">{option.detail}</span>
                ) : null}
              </span>
            </label>
          ))}
          {!visible.length ? (
            <p className="p-2 text-xs text-muted-foreground">No calendars found.</p>
          ) : null}
        </div>
      </PopoverPopup>
    </Popover>
  );
}
