import { Settings2Icon } from "lucide-react";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { InputGroup, InputGroupAddon, InputGroupInput, InputGroupText } from "../ui/input-group";
import {
  Popover,
  PopoverDescription,
  PopoverPopup,
  PopoverTitle,
  PopoverTrigger,
} from "../ui/popover";
import { Toggle, ToggleGroup } from "../ui/toggle-group";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import {
  defaultPlanningHours,
  validPlanningHours,
  type PlanningHours,
} from "./calendarAvailability";

/** Sunday-first, matching `Date.getDay()`; the initial is what the picker shows. */
const WEEKDAYS = [
  { value: "0", initial: "S", name: "Sunday" },
  { value: "1", initial: "M", name: "Monday" },
  { value: "2", initial: "T", name: "Tuesday" },
  { value: "3", initial: "W", name: "Wednesday" },
  { value: "4", initial: "T", name: "Thursday" },
  { value: "5", initial: "F", name: "Friday" },
  { value: "6", initial: "S", name: "Saturday" },
] as const;

/**
 * Everything the planner remembers about how you like to work, behind one
 * gear. These change rarely, so they no longer share the toolbar with the
 * week navigation.
 */
export function CalendarPlanningPreferences({
  minutes,
  onMinutes,
  hours,
  onHours,
  disabled,
}: {
  minutes: number;
  onMinutes: (minutes: number) => void;
  hours: PlanningHours;
  onHours: (hours: PlanningHours) => void;
  disabled: boolean;
}) {
  return (
    <Popover>
      <Tooltip>
        <TooltipTrigger
          render={
            <PopoverTrigger
              render={
                <Button
                  size="icon-sm"
                  variant="ghost"
                  aria-label="Planning preferences"
                  disabled={disabled}
                />
              }
            />
          }
        >
          <Settings2Icon className="size-3.5" />
        </TooltipTrigger>
        <TooltipPopup>Planning preferences</TooltipPopup>
      </Tooltip>
      <PopoverPopup align="end" className="w-80 max-w-[calc(100vw-2rem)]" viewportClassName="p-4">
        <PopoverTitle className="text-sm font-medium">Planning preferences</PopoverTitle>
        <PopoverDescription className="mt-1 text-xs text-muted-foreground">
          Saved on this device for this server.
        </PopoverDescription>

        <div className="mt-4 space-y-4">
          <label className="flex items-center justify-between gap-3">
            <span className="text-sm">New block length</span>
            <InputGroup className="w-28">
              <InputGroupInput
                type="number"
                min={5}
                max={1440}
                className="tabular-nums"
                aria-label="New block length in minutes"
                value={minutes}
                disabled={disabled}
                onChange={(e) => {
                  const next = Number(e.target.value);
                  if (Number.isInteger(next) && next >= 5 && next <= 1440) onMinutes(next);
                }}
              />
              <InputGroupAddon align="inline-end">
                <InputGroupText className="text-xs">min</InputGroupText>
              </InputGroupAddon>
            </InputGroup>
          </label>

          <div className="space-y-3 border-t border-border/60 pt-4">
            <div className="flex items-center justify-between gap-2">
              <p className="text-sm font-medium">Working hours</p>
              <Button
                size="xs"
                variant="ghost"
                disabled={disabled}
                onClick={() => onHours(defaultPlanningHours)}
              >
                Reset
              </Button>
            </div>
            <ToggleGroup
              aria-label="Working days"
              multiple
              disabled={disabled}
              value={hours.weekdays.map(String)}
              onValueChange={(value) =>
                onHours({ ...hours, weekdays: value.map(Number).sort((a, b) => a - b) })
              }
            >
              {WEEKDAYS.map((weekday) => (
                <Toggle
                  key={weekday.value}
                  aria-label={weekday.name}
                  value={weekday.value}
                  className="w-8"
                >
                  {weekday.initial}
                </Toggle>
              ))}
            </ToggleGroup>
            <div className="grid grid-cols-2 gap-2">
              <label className="flex flex-col gap-1">
                <span className="text-xs text-muted-foreground">Start</span>
                <Input
                  aria-label="Work starts"
                  size="sm"
                  type="time"
                  value={hours.start}
                  disabled={disabled}
                  onChange={(e) => onHours({ ...hours, start: e.target.value })}
                />
              </label>
              <label className="flex flex-col gap-1">
                <span className="text-xs text-muted-foreground">End</span>
                <Input
                  aria-label="Work ends"
                  size="sm"
                  type="time"
                  value={hours.end}
                  disabled={disabled}
                  onChange={(e) => onHours({ ...hours, end: e.target.value })}
                />
              </label>
              <label className="flex flex-col gap-1">
                <span className="text-xs text-muted-foreground">Break between blocks</span>
                <InputGroup>
                  <InputGroupInput
                    aria-label="Break around events in minutes"
                    type="number"
                    min={0}
                    max={120}
                    className="tabular-nums"
                    value={hours.breakMinutes}
                    disabled={disabled}
                    onChange={(e) => onHours({ ...hours, breakMinutes: Number(e.target.value) })}
                  />
                  <InputGroupAddon align="inline-end">
                    <InputGroupText className="text-xs">min</InputGroupText>
                  </InputGroupAddon>
                </InputGroup>
              </label>
              <label className="flex flex-col gap-1">
                <span className="text-xs text-muted-foreground">Focus per day</span>
                <InputGroup>
                  <InputGroupInput
                    aria-label="Daily focus limit in minutes"
                    type="number"
                    min={5}
                    max={1440}
                    className="tabular-nums"
                    value={hours.focusMinutes}
                    disabled={disabled}
                    onChange={(e) => onHours({ ...hours, focusMinutes: Number(e.target.value) })}
                  />
                  <InputGroupAddon align="inline-end">
                    <InputGroupText className="text-xs">min</InputGroupText>
                  </InputGroupAddon>
                </InputGroup>
              </label>
            </div>
            {validPlanningHours(hours) ? (
              <p className="text-xs text-muted-foreground">
                Suggested times fall inside these hours. The focus limit counts busy issue blocks on
                calendars checked for conflicts.
              </p>
            ) : (
              <p role="alert" className="text-xs text-destructive">
                Choose a working day, an end after the start, a break of 0–120 minutes, and a focus
                limit of 5–1,440 minutes.
              </p>
            )}
          </div>
        </div>
      </PopoverPopup>
    </Popover>
  );
}
