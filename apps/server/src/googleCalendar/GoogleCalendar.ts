import * as NodeCrypto from "node:crypto";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http";
import {
  GoogleCalendarError,
  type GoogleCalendarEvent,
  type GoogleCalendarScheduleInput,
  type GoogleCalendarUpdateInput,
} from "@t3tools/contracts";
import { ServerSecretStore } from "../auth/ServerSecretStore.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import { LinearApi } from "../linear/LinearApi.ts";

const SECRET = "google-calendar-oauth";
const API = "https://www.googleapis.com/calendar/v3";
const SCOPES = [
  "https://www.googleapis.com/auth/calendar.calendarlist.readonly",
  "https://www.googleapis.com/auth/calendar.events",
];
const fail = (message: string) => new GoogleCalendarError({ message });
const Tokens = Schema.Struct({
  clientId: Schema.optional(Schema.String),
  refreshToken: Schema.String,
  accessToken: Schema.String,
  expiresAt: Schema.Number,
});
const decodeTokens = Schema.decodeUnknownEffect(Schema.fromJsonString(Tokens));
const TokenResponse = Schema.Struct({
  access_token: Schema.String,
  expires_in: Schema.Number,
  refresh_token: Schema.optional(Schema.String),
});
const EventTime = Schema.Struct({
  dateTime: Schema.optional(Schema.String),
  date: Schema.optional(Schema.String),
});
const RawEvent = Schema.Struct({
  id: Schema.String,
  etag: Schema.String,
  summary: Schema.optional(Schema.String),
  htmlLink: Schema.optional(Schema.String),
  status: Schema.optional(Schema.String),
  eventType: Schema.optional(Schema.String),
  transparency: Schema.optional(Schema.String),
  recurringEventId: Schema.optional(Schema.String),
  recurrence: Schema.optional(Schema.Array(Schema.String)),
  start: Schema.optional(EventTime),
  end: Schema.optional(EventTime),
  extendedProperties: Schema.optional(
    Schema.Struct({ private: Schema.optional(Schema.Record(Schema.String, Schema.String)) }),
  ),
});
type RawEvent = typeof RawEvent.Type;
const EventPage = Schema.Struct({
  items: Schema.optional(Schema.Array(RawEvent)),
  nextPageToken: Schema.optional(Schema.String),
});
const CalendarPage = Schema.Struct({
  items: Schema.optional(
    Schema.Array(
      Schema.Struct({
        id: Schema.String,
        summary: Schema.optional(Schema.String),
        accessRole: Schema.String,
      }),
    ),
  ),
  nextPageToken: Schema.optional(Schema.String),
});

export function validateCalendarRange(start: string, end: string): void {
  const timestamp = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;
  const valid = (value: string) => {
    if (!timestamp.test(value)) return false;
    const year = Number(value.slice(0, 4));
    const month = Number(value.slice(5, 7));
    const day = Number(value.slice(8, 10));
    const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
    const monthDays = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
    return (
      month >= 1 &&
      month <= 12 &&
      day >= 1 &&
      day <= monthDays[month - 1]! &&
      Number(value.slice(11, 13)) < 24
    );
  };
  const duration = Date.parse(end) - Date.parse(start);
  if (
    !valid(start) ||
    !valid(end) ||
    !Number.isFinite(duration) ||
    duration <= 0 ||
    duration > 31 * 86_400_000
  ) {
    throw fail("Choose a valid start and end time, no more than 31 days apart.");
  }
}

function mapEvent(event: RawEvent): GoogleCalendarEvent {
  const metadata = event.extendedProperties?.private;
  return {
    id: event.id,
    etag: event.etag,
    title: event.summary ?? "Untitled event",
    url: event.htmlLink ?? "",
    start: event.start?.dateTime ?? event.start?.date ?? "",
    end: event.end?.dateTime ?? event.end?.date ?? "",
    allDay: event.start?.dateTime === undefined,
    blocksTime: event.transparency !== "transparent",
    recurring: event.recurringEventId !== undefined || event.recurrence !== undefined,
    issueIdentifier: metadata?.t3IssueIdentifier ?? null,
    createdByT3: metadata?.t3Created === "1",
  };
}

export const make = Effect.gen(function* () {
  const secrets = yield* ServerSecretStore;
  const linear = yield* LinearApi;
  const http = yield* HttpClient.HttpClient;
  const settings = yield* ServerSettingsService;
  const configuration = settings.getSettings.pipe(
    Effect.map((value) => value.googleCalendar),
    Effect.mapError(() => fail("Could not read Google Calendar settings.")),
  );
  const configured = (config: { clientId: string; clientSecret: string; redirectUri: string }) => {
    if (!config.clientId || !config.clientSecret || !config.redirectUri) return false;
    try {
      const url = new URL(config.redirectUri);
      return (
        !url.username &&
        !url.password &&
        !url.hash &&
        (url.protocol === "https:" ||
          (url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)))
      );
    } catch {
      return false;
    }
  };
  const fingerprint = (config: { clientId: string; clientSecret: string; redirectUri: string }) =>
    NodeCrypto.createHash("sha256")
      .update(config.clientId)
      .update("\0")
      .update(config.clientSecret)
      .update("\0")
      .update(config.redirectUri)
      .digest("hex");
  const lock = yield* Semaphore.make(1);
  let pending: { state: string; verifier: string; expiresAt: number; fingerprint: string } | null =
    null;

  const readTokens = Effect.fn("GoogleCalendar.readTokens")(function* () {
    const value = yield* secrets
      .get(SECRET)
      .pipe(Effect.mapError(() => fail("Could not read the Google Calendar connection.")));
    if (Option.isNone(value)) return null;
    return yield* decodeTokens(new TextDecoder().decode(value.value)).pipe(
      Effect.mapError(() => fail("Reconnect Google Calendar to repair its saved connection.")),
    );
  });
  const saveTokens = (value: typeof Tokens.Type) =>
    secrets
      .set(SECRET, new TextEncoder().encode(JSON.stringify(value)))
      .pipe(Effect.mapError(() => fail("Could not save the Google Calendar connection.")));

  const exchange = Effect.fn("GoogleCalendar.exchange")(function* (
    config: { clientId: string; clientSecret: string },
    parameters: Record<string, string>,
  ) {
    const response = yield* http
      .execute(
        HttpClientRequest.post("https://oauth2.googleapis.com/token").pipe(
          HttpClientRequest.bodyUrlParams({
            client_id: config.clientId,
            client_secret: config.clientSecret,
            ...parameters,
          }),
        ),
      )
      .pipe(
        Effect.timeout("20 seconds"),
        Effect.mapError(() => fail("Could not reach Google. Try connecting again.")),
      );
    if (response.status !== 200)
      return yield* fail("Google authorization expired or was denied. Reconnect Google Calendar.");
    return yield* response.json.pipe(
      Effect.timeout("20 seconds"),
      Effect.flatMap(Schema.decodeUnknownEffect(TokenResponse)),
      Effect.mapError(() => fail("Google returned an invalid authorization response.")),
    );
  });

  const accessToken = lock.withPermits(1)(
    Effect.gen(function* () {
      const config = yield* configuration;
      if (!configured(config))
        return yield* fail("Google Calendar OAuth is not configured on this server.");
      const tokens = yield* readTokens();
      if (!tokens || tokens.clientId !== config.clientId)
        return yield* fail("Connect Google Calendar in Settings → Integrations.");
      const now = yield* Clock.currentTimeMillis;
      if (tokens.expiresAt > now + 60_000) return tokens.accessToken;
      const result = yield* exchange(config, {
        grant_type: "refresh_token",
        refresh_token: tokens.refreshToken,
      });
      yield* saveTokens({
        clientId: config.clientId,
        refreshToken: result.refresh_token ?? tokens.refreshToken,
        accessToken: result.access_token,
        expiresAt: now + result.expires_in * 1000,
      });
      return result.access_token;
    }),
  );

  const request = Effect.fn("GoogleCalendar.request")(function* (
    method: "GET" | "POST" | "PATCH" | "DELETE",
    path: string,
    body?: unknown,
    etag?: string,
  ) {
    const token = yield* accessToken;
    let request = HttpClientRequest.make(method)(`${API}${path}`).pipe(
      HttpClientRequest.bearerToken(token),
    );
    if (body !== undefined) request = request.pipe(HttpClientRequest.bodyJsonUnsafe(body));
    if (etag) request = request.pipe(HttpClientRequest.setHeader("if-match", etag));
    return yield* http.execute(request).pipe(
      Effect.timeout("20 seconds"),
      Effect.mapError(() => fail("Could not reach Google Calendar. Refresh and try again.")),
    );
  });
  const checkResponse = (status: number) => {
    if (status >= 200 && status < 300) return Effect.void;
    return fail(
      status === 412
        ? "This event changed in Google Calendar. Refresh before trying again."
        : status === 401
          ? "Google authorization expired. Reconnect Google Calendar."
          : status === 403
            ? "Google denied access. Check calendar permissions and that the Calendar API is enabled."
            : status === 404 || status === 410
              ? "This calendar event is no longer available. Refresh the agenda."
              : status === 429
                ? "Google Calendar is busy. Wait a moment and try again."
                : "Google Calendar could not complete the request. Refresh and try again.",
    );
  };
  const json = <A>(
    response: HttpClientResponse.HttpClientResponse,
    schema: Schema.Decoder<A, never>,
  ) =>
    response.json.pipe(
      Effect.timeout("20 seconds"),
      Effect.flatMap(Schema.decodeUnknownEffect(schema)),
      Effect.mapError(() => fail("Google Calendar returned an invalid response.")),
    );
  const eventPath = (calendarId: string, eventId?: string) =>
    `/calendars/${encodeURIComponent(calendarId)}/events${eventId ? `/${encodeURIComponent(eventId)}` : ""}`;
  const getEvent = Effect.fn("GoogleCalendar.getEvent")(function* (
    calendarId: string,
    eventId: string,
  ) {
    const response = yield* request("GET", eventPath(calendarId, eventId));
    yield* checkResponse(response.status);
    return yield* json(response, RawEvent);
  });
  const range = (start: string, end: string) =>
    Effect.try({
      try: () => validateCalendarRange(start, end),
      catch: () => fail("Choose a valid start and end time, no more than 31 days apart."),
    });
  const resolveIssue = (reference: string) =>
    linear
      .getIssue({ reference })
      .pipe(
        Effect.mapError(() =>
          fail(
            "Could not load this Linear issue. Check the Linear connection and issue reference.",
          ),
        ),
      );

  return {
    status: Effect.gen(function* () {
      const config = yield* configuration;
      const tokens = yield* readTokens();
      return {
        configured: configured(config),
        connected: configured(config) && tokens !== null && tokens.clientId === config.clientId,
      };
    }),
    authorize: lock.withPermits(1)(
      Effect.gen(function* () {
        const config = yield* configuration;
        if (!configured(config))
          return yield* fail("Google Calendar OAuth is not configured on this server.");
        const verifier = NodeCrypto.randomBytes(32).toString("base64url");
        const state = NodeCrypto.randomBytes(32).toString("base64url");
        pending = {
          state,
          verifier,
          fingerprint: fingerprint(config),
          expiresAt: (yield* Clock.currentTimeMillis) + 10 * 60_000,
        };
        const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
        url.search = new URLSearchParams({
          client_id: config.clientId,
          redirect_uri: config.redirectUri,
          response_type: "code",
          scope: SCOPES.join(" "),
          access_type: "offline",
          prompt: "consent",
          state,
          code_challenge: NodeCrypto.createHash("sha256").update(verifier).digest("base64url"),
          code_challenge_method: "S256",
        }).toString();
        return { url: url.toString() };
      }),
    ),
    complete: (state: string, code: string) =>
      lock.withPermits(1)(
        Effect.gen(function* () {
          if (
            !pending ||
            pending.state !== state ||
            pending.expiresAt <= (yield* Clock.currentTimeMillis)
          )
            return yield* fail("This connection request expired. Start again from T3 settings.");
          const request = pending;
          const verifier = request.verifier;
          pending = null;
          const config = yield* configuration;
          if (!configured(config) || request.fingerprint !== fingerprint(config))
            return yield* fail(
              "Google Calendar settings changed. Start connecting again from Settings.",
            );
          if (!code)
            return yield* fail(
              "Google Calendar connection was cancelled. You can try again from T3 settings.",
            );
          const result = yield* exchange(config, {
            grant_type: "authorization_code",
            code,
            redirect_uri: config.redirectUri,
            code_verifier: verifier,
          });
          if (!result.refresh_token)
            return yield* fail(
              "Google did not grant offline access. Reconnect and allow calendar access.",
            );
          yield* saveTokens({
            clientId: config.clientId,
            refreshToken: result.refresh_token,
            accessToken: result.access_token,
            expiresAt: (yield* Clock.currentTimeMillis) + result.expires_in * 1000,
          });
        }),
      ),
    disconnect: lock.withPermits(1)(
      Effect.gen(function* () {
        pending = null;
        yield* secrets
          .remove(SECRET)
          .pipe(Effect.mapError(() => fail("Could not remove the Google Calendar connection.")));
      }),
    ),
    calendars: Effect.gen(function* () {
      const result: Array<{ id: string; title: string; writable: boolean }> = [];
      let pageToken = "";
      do {
        const response = yield* request(
          "GET",
          `/users/me/calendarList?${new URLSearchParams({ maxResults: "250", ...(pageToken ? { pageToken } : {}) })}`,
        );
        yield* checkResponse(response.status);
        const page = yield* json(response, CalendarPage);
        result.push(
          ...(page.items ?? [])
            .filter((c) => c.accessRole !== "freeBusyReader")
            .map((c) => ({
              id: c.id,
              title: c.summary ?? c.id,
              writable: c.accessRole === "owner" || c.accessRole === "writer",
            })),
        );
        pageToken = page.nextPageToken ?? "";
      } while (pageToken);
      return result;
    }),
    events: Effect.fn("GoogleCalendar.events")(function* (input: {
      calendarId: string;
      start: string;
      end: string;
    }) {
      yield* range(input.start, input.end);
      const result: GoogleCalendarEvent[] = [];
      let pageToken = "";
      do {
        const response = yield* request(
          "GET",
          `${eventPath(input.calendarId)}?${new URLSearchParams({ timeMin: input.start, timeMax: input.end, singleEvents: "true", orderBy: "startTime", maxResults: "250", ...(pageToken ? { pageToken } : {}) })}`,
        );
        yield* checkResponse(response.status);
        const page = yield* json(response, EventPage);
        result.push(...(page.items ?? []).filter((e) => e.status !== "cancelled").map(mapEvent));
        pageToken = page.nextPageToken ?? "";
      } while (pageToken);
      return result;
    }),
    schedule: Effect.fn("GoogleCalendar.schedule")(function* (input: GoogleCalendarScheduleInput) {
      yield* range(input.start, input.end);
      const issue = yield* resolveIssue(input.reference);
      const body = {
        id: input.requestId,
        summary: `${issue.identifier} ${issue.title}`,
        description: `Linear issue: ${issue.url}`,
        start: { dateTime: input.start },
        end: { dateTime: input.end },
        transparency: "opaque",
        extendedProperties: {
          private: { t3Created: "1", t3IssueId: issue.id, t3IssueIdentifier: issue.identifier },
        },
      };
      const response = yield* request("POST", eventPath(input.calendarId), body);
      if (response.status === 409) {
        const existing = yield* getEvent(input.calendarId, input.requestId);
        if (
          existing.extendedProperties?.private?.t3IssueId !== issue.id ||
          existing.extendedProperties.private.t3Created !== "1" ||
          existing.status === "cancelled"
        )
          return yield* fail(
            "This scheduling request conflicts with another event. Start a new scheduling request.",
          );
        return mapEvent(existing);
      }
      yield* checkResponse(response.status);
      return mapEvent(yield* json(response, RawEvent));
    }),
    update: Effect.fn("GoogleCalendar.update")(function* (input: GoogleCalendarUpdateInput) {
      const event = yield* getEvent(input.calendarId, input.eventId);
      if (event.etag !== input.etag)
        return yield* fail("This event changed in Google Calendar. Refresh before trying again.");
      if (
        !event.start?.dateTime ||
        event.recurringEventId ||
        event.recurrence ||
        (event.eventType && event.eventType !== "default")
      )
        return yield* fail(
          "Only individual, timed events can be changed here. Open Google Calendar for this event.",
        );
      const metadata = event.extendedProperties?.private ?? {};
      if ((input.action === "delete" || input.action === "move") && metadata.t3Created !== "1")
        return yield* fail("Only T3-created work blocks can be moved or unscheduled here.");
      let body: unknown;
      if (input.action === "link") {
        const issue = yield* resolveIssue(input.reference);
        body = {
          extendedProperties: {
            private: { ...metadata, t3IssueId: issue.id, t3IssueIdentifier: issue.identifier },
          },
        };
      } else if (input.action === "unlink") {
        body = {
          extendedProperties: {
            private: { ...metadata, t3IssueId: null, t3IssueIdentifier: null },
          },
        };
      } else if (input.action === "move") {
        yield* range(input.start, input.end);
        body = { start: { dateTime: input.start }, end: { dateTime: input.end } };
      }
      const response = yield* request(
        input.action === "delete" ? "DELETE" : "PATCH",
        eventPath(input.calendarId, input.eventId),
        body,
        input.etag,
      );
      yield* checkResponse(response.status);
    }),
  };
});

export class GoogleCalendar extends Context.Service<GoogleCalendar, Effect.Success<typeof make>>()(
  "t3/googleCalendar/GoogleCalendar",
) {}
export const layer = Layer.effect(GoogleCalendar, make);
