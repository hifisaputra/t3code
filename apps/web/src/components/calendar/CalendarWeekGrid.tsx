import { useCallback, type DragEvent, type MutableRefObject } from "react";
import { cn } from "~/lib/utils";
import { clockMinute, validPlanningHours, type PlanningHours } from "./calendarAvailability";
import { layoutCalendarDay, type CalendarEntry } from "./calendarPlanning";
import { calendarColorClass, formatClockTime } from "./calendarPresentation";

export type Drag = { reference: string } | { event: CalendarEntry; resize: boolean };

/** A block shorter than this cannot show its time range and its action legibly. */
const READABLE_BLOCK_MINUTES = 40;

const weekdayLabel = (day: string) =>
  new Date(`${day}T12:00:00`).toLocaleDateString([], { weekday: "short" });

/** The half-hour slot under the pointer, in minutes since midnight. */
const minuteAt = (e: DragEvent<HTMLElement>) =>
  Math.max(
    0,
    Math.min(1410, Math.floor((e.clientY - e.currentTarget.getBoundingClientRect().top) / 30) * 30),
  );

/**
 * Seven days at a minute per pixel. It draws what it is given and reports
 * pointer intent; the planner owns the drag payload and what a drop means.
 */
export function CalendarWeekGrid({
  days,
  today,
  minutesNow,
  entries,
  calendarIds,
  hours,
  busy,
  drag,
  placing,
  preview,
  writable,
  onSlotClick,
  onDragOver,
  onDragLeave,
  onDrop,
  onDragEnd,
  onBlockClick,
  onWork,
  hasThread,
}: {
  days: readonly string[];
  today: string;
  minutesNow: number;
  entries: readonly CalendarEntry[];
  /** Calendar order decides block colour, so every view paints a calendar the same. */
  calendarIds: readonly string[];
  hours: PlanningHours;
  busy: boolean;
  drag: MutableRefObject<Drag | null>;
  /** A block is being placed, so clicking a slot moves it there. */
  placing: boolean;
  preview: { event: CalendarEntry; overlaps: boolean; dropping: boolean } | null;
  writable: (event: CalendarEntry) => boolean;
  onSlotClick: (day: string, time: string) => void;
  onDragOver: (day: string, minute: number) => void;
  onDragLeave: () => void;
  onDrop: (day: string, minute: number) => void;
  onDragEnd: () => void;
  onBlockClick: (event: CalendarEntry) => void;
  onWork: (identifier: string) => void;
  hasThread: (identifier: string) => boolean;
}) {
  const scrollToMorning = useCallback((node: HTMLDivElement | null) => {
    if (node) node.scrollTop = 480;
  }, []);
  const shading = validPlanningHours(hours)
    ? { start: clockMinute(hours.start), end: clockMinute(hours.end) }
    : null;
  const colorOf = (event: CalendarEntry) =>
    calendarColorClass(Math.max(0, calendarIds.indexOf(event.calendarId)));
  return (
    <div ref={scrollToMorning} className="min-h-0 overflow-auto">
      <div className="grid min-w-[840px] grid-cols-[3.25rem_repeat(7,minmax(0,1fr))]">
        <div className="sticky top-0 z-20 border-b border-border/60 bg-background" />
        {days.map((date) => {
          const isToday = date === today;
          return (
            <div
              key={date}
              className="sticky top-0 z-20 border-b border-l border-border/60 bg-background px-1.5 py-1.5 text-center"
            >
              <div
                className={cn(
                  "text-xs font-medium",
                  isToday ? "text-primary" : "text-muted-foreground",
                )}
              >
                {weekdayLabel(date)}
              </div>
              <div className={cn("text-lg font-semibold tabular-nums", isToday && "text-primary")}>
                {isToday ? (
                  <span className="inline-flex size-7 items-center justify-center rounded-full bg-primary text-primary-foreground">
                    {new Date(`${date}T12:00:00`).getDate()}
                  </span>
                ) : (
                  new Date(`${date}T12:00:00`).getDate()
                )}
              </div>
              <div className="mt-1 space-y-0.5">
                {entries
                  .filter((event) => event.allDay && event.start <= date && event.end > date)
                  .map((event) => (
                    <p
                      key={`${event.calendarId}:${event.id}`}
                      className={cn(
                        "truncate rounded-md border px-1.5 py-0.5 text-left text-[11px]",
                        colorOf(event),
                      )}
                      aria-label={`${event.calendarTitle}: ${event.title}`}
                    >
                      {event.title}
                    </p>
                  ))}
              </div>
            </div>
          );
        })}

        <div className="relative h-[1440px]">
          {Array.from({ length: 24 }, (_, hour) => (
            <span
              key={hour}
              className="-translate-y-1/2 absolute right-1.5 text-[11px] tabular-nums text-muted-foreground/70"
              style={{ top: hour * 60 }}
            >
              {String(hour).padStart(2, "0")}:00
            </span>
          ))}
        </div>
        {days.map((date) => {
          const isToday = date === today;
          const workingDay =
            !shading || hours.weekdays.includes(new Date(`${date}T12:00:00`).getDay());
          return (
            <div
              key={date}
              className={cn(
                "relative h-[1440px] border-l border-border/60",
                !workingDay && "bg-muted/30",
                isToday && "bg-primary/[0.03]",
              )}
              onDragOver={(e) => {
                if (!drag.current || busy) return;
                e.preventDefault();
                onDragOver(date, minuteAt(e));
              }}
              onDragLeave={(e) => {
                if (
                  !(e.relatedTarget instanceof Node) ||
                  !e.currentTarget.contains(e.relatedTarget)
                )
                  onDragLeave();
              }}
              onDrop={(e) => {
                e.preventDefault();
                onDrop(date, minuteAt(e));
              }}
            >
              {/* Hours outside the working day are dimmed so the eye lands
                  where suggestions will. Non-working days dim whole. */}
              {shading && workingDay ? (
                <>
                  <div
                    aria-hidden
                    className="pointer-events-none absolute inset-x-0 top-0 bg-muted/30"
                    style={{ height: shading.start }}
                  />
                  <div
                    aria-hidden
                    className="pointer-events-none absolute inset-x-0 bottom-0 bg-muted/30"
                    style={{ height: 1440 - shading.end }}
                  />
                </>
              ) : null}
              {Array.from({ length: 48 }, (_, slot) => {
                const time = `${String(Math.floor(slot / 2)).padStart(2, "0")}:${slot % 2 ? "30" : "00"}`;
                return (
                  <button
                    key={slot}
                    type="button"
                    aria-label={`${date} ${time}`}
                    tabIndex={placing ? 0 : -1}
                    className={cn(
                      "absolute left-0 h-[30px] w-full border-t transition-colors",
                      slot % 2 ? "border-border/25" : "border-border/50",
                      placing ? "cursor-copy hover:bg-accent/40" : "cursor-default",
                    )}
                    style={{ top: slot * 30 }}
                    disabled={busy}
                    onClick={() => {
                      if (placing) onSlotClick(date, time);
                    }}
                  />
                );
              })}
              {isToday ? (
                <div
                  aria-hidden
                  className="pointer-events-none absolute inset-x-0 z-10 h-px bg-destructive"
                  style={{ top: minutesNow }}
                >
                  <span className="-top-[3px] -left-1 absolute size-2 rounded-full bg-destructive" />
                </div>
              ) : null}
              {layoutCalendarDay(entries, date).map(({ event, top, bottom, lane, lanes }) => {
                const tall = bottom - top >= READABLE_BLOCK_MINUTES;
                const movable = !busy && writable(event);
                return (
                  <div
                    key={`${event.calendarId}:${event.id}`}
                    draggable={movable}
                    onDragStart={(e) => {
                      drag.current = { event, resize: false };
                      e.dataTransfer.setData("text/plain", event.id);
                      e.dataTransfer.effectAllowed = "move";
                    }}
                    onDragEnd={onDragEnd}
                    className={cn(
                      "group absolute overflow-hidden rounded-md border px-1.5 py-1 text-[11px] leading-tight shadow-xs/5",
                      colorOf(event),
                      event.blocksTime === false && "border-dashed bg-transparent",
                      movable && "cursor-grab active:cursor-grabbing",
                    )}
                    style={{
                      top,
                      height: Math.max(15, bottom - top),
                      left: `${(lane / lanes) * 100}%`,
                      width: `${100 / lanes}%`,
                    }}
                    aria-label={`${event.calendarTitle}: ${event.title}`}
                  >
                    <button
                      type="button"
                      className="block w-full truncate text-left font-medium"
                      disabled={busy}
                      onClick={() => onBlockClick(event)}
                    >
                      {event.title}
                      {event.blocksTime === false ? " · Free" : ""}
                    </button>
                    {tall ? (
                      <p className="tabular-nums opacity-80">
                        {formatClockTime(event.start)} – {formatClockTime(event.end)}
                      </p>
                    ) : null}
                    {tall && event.issueIdentifier ? (
                      <button
                        type="button"
                        className="mt-0.5 inline-flex items-center gap-1 rounded px-1 underline-offset-2 transition-colors hover:bg-background/40 hover:underline"
                        onClick={() => {
                          if (event.issueIdentifier) onWork(event.issueIdentifier);
                        }}
                      >
                        {hasThread(event.issueIdentifier) ? "Resume" : "Start working"}
                      </button>
                    ) : null}
                    {writable(event) ? (
                      <button
                        type="button"
                        aria-label={`Resize ${event.title}`}
                        disabled={busy}
                        draggable={!busy}
                        className="absolute inset-x-0 bottom-0 h-2 cursor-ns-resize opacity-0 transition-opacity after:absolute after:top-0.5 after:left-1/2 after:h-0.5 after:w-6 after:-translate-x-1/2 after:rounded-full after:bg-current/40 after:content-[''] group-hover:opacity-100"
                        onClick={() => onBlockClick(event)}
                        onDragStart={(e) => {
                          e.stopPropagation();
                          drag.current = { event, resize: true };
                          e.dataTransfer.setData("text/plain", event.id);
                        }}
                        onDragEnd={onDragEnd}
                      />
                    ) : null}
                  </div>
                );
              })}
              {preview
                ? layoutCalendarDay([preview.event], date).map(({ top, bottom }) => (
                    <div
                      key="preview"
                      role="status"
                      className={cn(
                        "pointer-events-none absolute inset-x-0.5 z-10 overflow-hidden rounded-md border-2 border-dashed px-1.5 py-1 text-[11px] leading-tight",
                        preview.overlaps
                          ? "border-warning bg-warning-surface text-warning-foreground"
                          : "border-primary bg-primary/10 text-foreground",
                      )}
                      style={{ top, height: Math.max(15, bottom - top) }}
                    >
                      <p className="truncate">
                        <span className="font-semibold">
                          {preview.dropping ? "Drop here" : "Not saved"}
                        </span>{" "}
                        · {preview.event.title}
                      </p>
                      <p className="tabular-nums opacity-80">
                        {formatClockTime(preview.event.start)} –{" "}
                        {formatClockTime(preview.event.end)}
                      </p>
                      {preview.overlaps ? <p>Overlaps an event</p> : null}
                    </div>
                  ))
                : null}
            </div>
          );
        })}
      </div>
    </div>
  );
}
