export function localCalendarDate(date = new Date()): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

export function calendarDayRange(day: string): { start: string; end: string } | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return null;
  const start = new Date(`${day}T00:00:00`);
  if (!Number.isFinite(start.getTime()) || localCalendarDate(start) !== day) return null;
  const end = new Date(start);
  end.setDate(end.getDate() + 1);
  return { start: start.toISOString(), end: end.toISOString() };
}

export function calendarBlockRange(
  day: string,
  time: string,
  minutes: number,
): { start: string; end: string } | null {
  if (
    !calendarDayRange(day) ||
    !/^\d{2}:\d{2}$/.test(time) ||
    !Number.isInteger(minutes) ||
    minutes < 5 ||
    minutes > 1440
  )
    return null;
  const start = new Date(`${day}T${time}:00`);
  // Reject nonexistent local times during a spring DST transition.
  if (
    !Number.isFinite(start.getTime()) ||
    localCalendarDate(start) !== day ||
    `${String(start.getHours()).padStart(2, "0")}:${String(start.getMinutes()).padStart(2, "0")}` !==
      time
  )
    return null;
  return {
    start: start.toISOString(),
    end: new Date(start.getTime() + minutes * 60_000).toISOString(),
  };
}
