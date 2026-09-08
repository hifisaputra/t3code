import * as Schema from "effect/Schema";
import { TrimmedNonEmptyString } from "./baseSchemas.ts";

export class GoogleCalendarError extends Schema.TaggedErrorClass<GoogleCalendarError>()(
  "GoogleCalendarError",
  { message: Schema.String },
) {}

export const GoogleCalendarStatus = Schema.Struct({
  configured: Schema.Boolean,
  connected: Schema.Boolean,
});
export const GoogleCalendarCalendar = Schema.Struct({
  id: Schema.String,
  title: Schema.String,
  writable: Schema.Boolean,
});
export const GoogleCalendarEvent = Schema.Struct({
  id: Schema.String,
  etag: Schema.String,
  title: Schema.String,
  url: Schema.String,
  start: Schema.String,
  end: Schema.String,
  allDay: Schema.Boolean,
  recurring: Schema.Boolean,
  blocksTime: Schema.optional(Schema.Boolean),
  issueIdentifier: Schema.NullOr(Schema.String),
  createdByT3: Schema.Boolean,
});
export type GoogleCalendarEvent = typeof GoogleCalendarEvent.Type;
export const GoogleCalendarEventsInput = Schema.Struct({
  calendarId: TrimmedNonEmptyString,
  start: TrimmedNonEmptyString,
  end: TrimmedNonEmptyString,
});
export const GoogleCalendarScheduleInput = Schema.Struct({
  ...GoogleCalendarEventsInput.fields,
  reference: TrimmedNonEmptyString,
  requestId: Schema.String.check(Schema.isPattern(/^[a-f0-9]{32}$/)),
});
export type GoogleCalendarScheduleInput = typeof GoogleCalendarScheduleInput.Type;
const eventTarget = {
  calendarId: TrimmedNonEmptyString,
  eventId: TrimmedNonEmptyString,
  etag: TrimmedNonEmptyString,
};
export const GoogleCalendarUpdateInput = Schema.Union([
  Schema.Struct({
    ...eventTarget,
    action: Schema.Literal("link"),
    reference: TrimmedNonEmptyString,
  }),
  Schema.Struct({ ...eventTarget, action: Schema.Literal("unlink") }),
  Schema.Struct({ ...eventTarget, action: Schema.Literal("delete") }),
  Schema.Struct({
    ...eventTarget,
    action: Schema.Literal("move"),
    start: TrimmedNonEmptyString,
    end: TrimmedNonEmptyString,
  }),
]);
export type GoogleCalendarUpdateInput = typeof GoogleCalendarUpdateInput.Type;
