import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as TestClock from "effect/testing/TestClock";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http";
import { GoogleCalendar, layer, validateCalendarRange } from "./GoogleCalendar.ts";
import { ServerSecretStore } from "../auth/ServerSecretStore.ts";
import * as LinearApi from "../linear/LinearApi.ts";
import * as ServerSettings from "../serverSettings.ts";

const EVENT = {
  id: "event1",
  etag: '"v1"',
  summary: "Work",
  htmlLink: "https://calendar.google.com/event?eid=event1",
  start: { dateTime: "2026-09-09T08:00:00Z" },
  end: { dateTime: "2026-09-09T09:00:00Z" },
};
const ISSUE = {
  id: "issue1",
  identifier: "DEL-123",
  title: "Fix login",
  url: "https://linear.app/team/issue/DEL-123",
  branchName: "del-123",
  priority: 1,
  updatedAt: "2026-09-08T00:00:00Z",
  state: { id: "state1", name: "Todo", type: "unstarted", color: "#fff", position: 0 },
  team: { id: "team1", key: "DEL", name: "Delivery" },
  assignee: null,
  project: null,
  cycle: null,
  description: null,
  parent: null,
  children: { nodes: [] },
  labels: { nodes: [] },
  comments: { nodes: [] },
};
const target = { calendarId: "work@example.com", eventId: EVENT.id, etag: EVENT.etag };
const range = { start: "2026-09-09T08:00:00Z", end: "2026-09-09T09:00:00Z" };

function fixture(
  options: {
    connected?: boolean;
    expiresAt?: number;
    configured?: boolean;
    response?: (request: HttpClientRequest.HttpClientRequest) => Response;
  } = {},
) {
  const stored = new Map<string, Uint8Array>();
  const encode = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));
  if (options.connected !== false)
    stored.set(
      "google-calendar-oauth",
      encode({
        clientId: "client-id",
        accessToken: "access-secret",
        refreshToken: "refresh-secret",
        expiresAt: options.expiresAt ?? 9e15,
      }),
    );
  const requests: HttpClientRequest.HttpClientRequest[] = [];
  const http = Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request) => {
      requests.push(request);
      const response =
        request.url === "https://api.linear.app/graphql"
          ? Response.json({ data: { issue: ISSUE } })
          : (options.response?.(request) ?? Response.json({}));
      return Effect.succeed(HttpClientResponse.fromWeb(request, response));
    }),
  );
  const secrets = Layer.succeed(
    ServerSecretStore,
    ServerSecretStore.of({
      get: (name) => Effect.sync(() => Option.fromUndefinedOr(stored.get(name))),
      set: (name, value) =>
        Effect.sync(() => {
          stored.set(name, value);
        }),
      remove: (name) =>
        Effect.sync(() => {
          stored.delete(name);
        }),
      create: () => Effect.die("unused"),
      getOrCreateRandom: () => Effect.die("unused"),
    }),
  );
  const settings = ServerSettings.layerTest({
    linear: { apiKey: "linear-key" },
    googleCalendar:
      options.configured === false
        ? {}
        : {
            clientId: "client-id",
            clientSecret: "client-secret",
            redirectUri: "https://t3.example.com/oauth/google-calendar/callback",
          },
  });
  const testLayer = layer.pipe(
    Layer.provide(LinearApi.layer),
    Layer.provideMerge(settings),
    Layer.provide(secrets),
    Layer.provide(http),
  );
  return { stored, requests, layer: testLayer };
}

function body(request: HttpClientRequest.HttpClientRequest): Record<string, unknown> {
  assert.equal(request.body._tag, "Uint8Array");
  if (request.body._tag !== "Uint8Array") throw new Error("Expected JSON body");
  return JSON.parse(new TextDecoder().decode(request.body.body));
}

it.effect("reports an unconfigured connection without network calls", () => {
  const f = fixture({ configured: false, connected: false });
  return Effect.gen(function* () {
    const service = yield* GoogleCalendar;
    assert.deepEqual(yield* service.status, { configured: false, connected: false });
    assert.equal(f.requests.length, 0);
  }).pipe(Effect.provide(f.layer));
});

it.effect("validates OAuth state, uses PKCE, saves server-side tokens, and rejects replay", () => {
  const f = fixture({
    connected: false,
    response: () =>
      Response.json({ access_token: "access", refresh_token: "refresh", expires_in: 3600 }),
  });
  return Effect.gen(function* () {
    const service = yield* GoogleCalendar;
    const authorization = new URL((yield* service.authorize).url);
    assert.equal(authorization.searchParams.get("code_challenge_method"), "S256");
    assert.isNotNull(authorization.searchParams.get("code_challenge"));
    assert.isFalse(authorization.href.includes("client-secret"));
    const state = authorization.searchParams.get("state")!;
    assert.match((yield* Effect.flip(service.complete("wrong", "code"))).message, /expired/);
    assert.equal(f.requests.length, 0);
    yield* service.complete(state, "code");
    assert.deepEqual(yield* service.status, { configured: true, connected: true });
    assert.equal(f.stored.size, 1);
    assert.match((yield* Effect.flip(service.complete(state, "code"))).message, /expired/);
    assert.equal(f.requests.length, 1);
  }).pipe(Effect.provide(f.layer));
});

it.effect("expires OAuth requests and cancels pending connection on disconnect", () => {
  const f = fixture({ connected: false });
  return Effect.gen(function* () {
    const service = yield* GoogleCalendar;
    const state = new URL((yield* service.authorize).url).searchParams.get("state")!;
    yield* TestClock.adjust("11 minutes");
    assert.match((yield* Effect.flip(service.complete(state, "code"))).message, /expired/);
    const next = new URL((yield* service.authorize).url).searchParams.get("state")!;
    yield* service.disconnect;
    assert.match((yield* Effect.flip(service.complete(next, "code"))).message, /expired/);
    assert.equal(f.requests.length, 0);
  }).pipe(Effect.provide(f.layer));
});

it.effect("refreshes expired credentials once and disconnects without deleting events", () => {
  const f = fixture({
    expiresAt: 0,
    response: (r) =>
      r.url.includes("oauth2")
        ? Response.json({ access_token: "fresh", expires_in: 3600 })
        : Response.json({ items: [] }),
  });
  return Effect.gen(function* () {
    const service = yield* GoogleCalendar;
    yield* service.calendars;
    yield* service.calendars;
    assert.equal(f.requests.filter((r) => r.url.includes("oauth2")).length, 1);
    assert.equal(f.requests[1]?.headers.authorization, "Bearer fresh");
    yield* service.disconnect;
    assert.equal(f.stored.size, 0);
    assert.isFalse((yield* service.status).connected);
    assert.match((yield* Effect.flip(service.calendars)).message, /Connect Google Calendar/);
    assert.equal(f.requests.length, 3);
  }).pipe(Effect.provide(f.layer));
});

it.effect("paginates events, preserves all-day entries, and omits cancellations", () => {
  const f = fixture({
    response: (r) =>
      r.url.includes("pageToken=")
        ? Response.json({
            items: [
              {
                ...EVENT,
                id: "all-day",
                transparency: "transparent",
                start: { date: "2026-09-09" },
                end: { date: "2026-09-10" },
              },
              { ...EVENT, id: "cancelled", status: "cancelled" },
            ],
          })
        : Response.json({
            items: [
              {
                ...EVENT,
                extendedProperties: { private: { t3IssueIdentifier: "DEL-123", t3Created: "1" } },
              },
            ],
            nextPageToken: "page2",
          }),
  });
  return Effect.gen(function* () {
    const service = yield* GoogleCalendar;
    const events = yield* service.events({ calendarId: target.calendarId, ...range });
    assert.equal(events.length, 2);
    assert.equal(events[0]?.issueIdentifier, "DEL-123");
    assert.isTrue(events[0]?.createdByT3);
    assert.isTrue(events[1]?.allDay);
    assert.isTrue(events[0]?.blocksTime);
    assert.isFalse(events[1]?.blocksTime);
    assert.equal(f.requests.length, 2);
  }).pipe(Effect.provide(f.layer));
});

it.effect("links an existing event with an ETag without overwriting its other fields", () => {
  const f = fixture({
    response: (r) =>
      r.method === "GET"
        ? Response.json({ ...EVENT, extendedProperties: { private: { otherApp: "keep" } } })
        : new Response(null, { status: 200 }),
  });
  return Effect.gen(function* () {
    const service = yield* GoogleCalendar;
    yield* service.update({ ...target, action: "link", reference: "DEL-123" });
    const patch = f.requests.find((r) => r.method === "PATCH")!;
    assert.equal(patch.headers["if-match"], EVENT.etag);
    assert.deepEqual(body(patch), {
      extendedProperties: {
        private: { otherApp: "keep", t3IssueId: "issue1", t3IssueIdentifier: "DEL-123" },
      },
    });
  }).pipe(Effect.provide(f.layer));
});

it.effect("unlinks only issue metadata and preserves event ownership", () => {
  const f = fixture({
    response: (r) =>
      r.method === "GET"
        ? Response.json({
            ...EVENT,
            extendedProperties: {
              private: {
                otherApp: "keep",
                t3Created: "1",
                t3IssueIdentifier: "DEL-123",
                t3IssueId: "issue1",
              },
            },
          })
        : new Response(null, { status: 200 }),
  });
  return Effect.gen(function* () {
    const service = yield* GoogleCalendar;
    yield* service.update({ ...target, action: "unlink" });
    assert.deepEqual(body(f.requests[1]!), {
      extendedProperties: {
        private: { otherApp: "keep", t3Created: "1", t3IssueIdentifier: null, t3IssueId: null },
      },
    });
  }).pipe(Effect.provide(f.layer));
});

it.effect("rejects stale ETags and never deletes unrelated meetings", () => {
  const f = fixture({ response: () => Response.json(EVENT) });
  return Effect.gen(function* () {
    const service = yield* GoogleCalendar;
    assert.match(
      (yield* Effect.flip(service.update({ ...target, etag: '"old"', action: "unlink" }))).message,
      /changed/,
    );
    assert.match(
      (yield* Effect.flip(service.update({ ...target, action: "delete" }))).message,
      /Only T3-created/,
    );
    assert.isTrue(f.requests.every((r) => r.method === "GET"));
  }).pipe(Effect.provide(f.layer));
});

it.effect("surfaces a Google concurrent-write rejection", () => {
  const f = fixture({
    response: (r) =>
      r.method === "GET" ? Response.json(EVENT) : new Response(null, { status: 412 }),
  });
  return Effect.gen(function* () {
    const service = yield* GoogleCalendar;
    assert.match(
      (yield* Effect.flip(service.update({ ...target, action: "unlink" }))).message,
      /changed/,
    );
  }).pipe(Effect.provide(f.layer));
});

it.effect("rejects modifying recurring or all-day events", () => {
  const f = fixture({ response: () => Response.json({ ...EVENT, recurringEventId: "series1" }) });
  return Effect.gen(function* () {
    const service = yield* GoogleCalendar;
    assert.match(
      (yield* Effect.flip(service.update({ ...target, action: "link", reference: "DEL-123" })))
        .message,
      /individual, timed/,
    );
    assert.equal(f.requests.length, 1);
  }).pipe(Effect.provide(f.layer));
});

it.effect("retries creation with the same event ID and resolves an existing work block", () => {
  const requestId = "a".repeat(32);
  const f = fixture({
    response: (r) =>
      r.method === "POST"
        ? new Response(null, { status: 409 })
        : Response.json({
            ...EVENT,
            id: requestId,
            extendedProperties: {
              private: { t3IssueId: "issue1", t3IssueIdentifier: "DEL-123", t3Created: "1" },
            },
          }),
  });
  return Effect.gen(function* () {
    const service = yield* GoogleCalendar;
    const event = yield* service.schedule({
      calendarId: target.calendarId,
      ...range,
      reference: "DEL-123",
      requestId,
    });
    assert.equal(event.id, requestId);
    const creation = f.requests.find((r) => r.method === "POST" && r.url.includes("calendar/v3"))!;
    assert.equal(body(creation).id, requestId);
    assert.equal(body(creation).description, `Linear issue: ${ISSUE.url}`);
  }).pipe(Effect.provide(f.layer));
});

it("rejects ambiguous timestamps and invalid ranges", () => {
  assert.throws(() => validateCalendarRange("2026-09-09T10:00:00", "2026-09-09T11:00:00"));
  assert.throws(() => validateCalendarRange(range.end, range.start));
  assert.throws(() => validateCalendarRange("badZ", range.end));
  assert.throws(() => validateCalendarRange("2026-02-30T08:00:00Z", "2026-03-03T08:00:00Z"));
  assert.doesNotThrow(() =>
    validateCalendarRange("2026-09-09T10:00:00+02:00", "2026-09-09T11:00:00+02:00"),
  );
});

it.effect("moves and deletes a T3-created block with conditional writes", () => {
  const f = fixture({
    response: (r) =>
      r.method === "GET"
        ? Response.json({ ...EVENT, extendedProperties: { private: { t3Created: "1" } } })
        : new Response(null, { status: 204 }),
  });
  return Effect.gen(function* () {
    const service = yield* GoogleCalendar;
    yield* service.update({ ...target, action: "move", ...range });
    const patch = f.requests[1]!;
    assert.equal(patch.method, "PATCH");
    assert.equal(patch.headers["if-match"], EVENT.etag);
    assert.deepEqual(body(patch), {
      start: { dateTime: range.start },
      end: { dateTime: range.end },
    });
    yield* service.update({ ...target, action: "delete" });
    assert.equal(f.requests[3]?.method, "DELETE");
    assert.equal(f.requests[3]?.headers["if-match"], EVENT.etag);
  }).pipe(Effect.provide(f.layer));
});

it.effect("paginates calendars and identifies writable calendars", () => {
  const f = fixture({
    response: (r) =>
      r.url.includes("pageToken=")
        ? Response.json({
            items: [
              { id: "shared", summary: "Shared", accessRole: "reader" },
              { id: "busy", accessRole: "freeBusyReader" },
            ],
          })
        : Response.json({
            items: [{ id: "mine", summary: "Work", accessRole: "owner" }],
            nextPageToken: "next",
          }),
  });
  return Effect.gen(function* () {
    const service = yield* GoogleCalendar;
    assert.deepEqual(yield* service.calendars, [
      { id: "mine", title: "Work", writable: true },
      { id: "shared", title: "Shared", writable: false },
    ]);
    assert.equal(f.requests.length, 2);
  }).pipe(Effect.provide(f.layer));
});

it.effect("does not leak Google response bodies when authorization fails", () => {
  const f = fixture({ response: () => Response.json({ error: "access-secret" }, { status: 401 }) });
  return Effect.gen(function* () {
    const service = yield* GoogleCalendar;
    const error = yield* Effect.flip(service.calendars);
    assert.include(error.message, "Reconnect");
    assert.notInclude(error.message, "access-secret");
  }).pipe(Effect.provide(f.layer));
});

it.effect("uses saved OAuth settings immediately and rejects a callback after they change", () => {
  const f = fixture({ configured: false, connected: false });
  return Effect.gen(function* () {
    const service = yield* GoogleCalendar;
    const settings = yield* ServerSettings.ServerSettingsService;
    yield* settings.updateSettings({
      googleCalendar: {
        clientId: "new-client",
        clientSecret: "new-secret",
        redirectUri: "https://t3.example.com/oauth/google-calendar/callback",
      },
    });
    assert.deepEqual(yield* service.status, { configured: true, connected: false });
    const url = new URL((yield* service.authorize).url);
    assert.equal(url.searchParams.get("client_id"), "new-client");
    yield* settings.updateSettings({ googleCalendar: { clientSecret: "rotated-secret" } });
    assert.match(
      (yield* Effect.flip(service.complete(url.searchParams.get("state")!, "code"))).message,
      /settings changed/,
    );
    assert.equal(f.requests.length, 0);
  }).pipe(Effect.provide(f.layer));
});

it.effect(
  "requires reconnection after switching clients and disables access when the secret is removed",
  () => {
    const f = fixture();
    return Effect.gen(function* () {
      const service = yield* GoogleCalendar;
      const settings = yield* ServerSettings.ServerSettingsService;
      assert.isTrue((yield* service.status).connected);
      yield* settings.updateSettings({ googleCalendar: { clientId: "different-client" } });
      assert.isFalse((yield* service.status).connected);
      assert.match((yield* Effect.flip(service.calendars)).message, /Connect Google Calendar/);
      yield* settings.updateSettings({ googleCalendar: { clientSecret: "" } });
      assert.isFalse((yield* service.status).configured);
      assert.match((yield* Effect.flip(service.authorize)).message, /not configured/);
      assert.equal(f.requests.length, 0);
    }).pipe(Effect.provide(f.layer));
  },
);

it.effect("rejects unsafe callback URLs before redirecting to Google", () => {
  const f = fixture({ connected: false });
  return Effect.gen(function* () {
    const service = yield* GoogleCalendar;
    const settings = yield* ServerSettings.ServerSettingsService;
    for (const redirectUri of [
      "https://user:password@example.com/callback",
      "http://example.com/callback",
      "javascript:alert(1)",
    ]) {
      yield* settings.updateSettings({ googleCalendar: { redirectUri } });
      assert.isFalse((yield* service.status).configured);
      yield* Effect.flip(service.authorize);
    }
    yield* settings.updateSettings({
      googleCalendar: { redirectUri: "http://localhost:3773/oauth/google-calendar/callback" },
    });
    assert.isTrue((yield* service.status).configured);
    assert.equal(f.requests.length, 0);
  }).pipe(Effect.provide(f.layer));
});
