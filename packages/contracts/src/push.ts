import * as Schema from "effect/Schema";
import { TrimmedNonEmptyString } from "./baseSchemas.ts";

const PUSH_FIELD_MAX_LENGTH = 1024;

export const PushSubscriptionKeys = Schema.Struct({
  p256dh: TrimmedNonEmptyString.check(Schema.isMaxLength(PUSH_FIELD_MAX_LENGTH)),
  auth: TrimmedNonEmptyString.check(Schema.isMaxLength(PUSH_FIELD_MAX_LENGTH)),
});
export type PushSubscriptionKeys = typeof PushSubscriptionKeys.Type;

export const PushSubscriptionInput = Schema.Struct({
  endpoint: TrimmedNonEmptyString.check(Schema.isMaxLength(PUSH_FIELD_MAX_LENGTH)),
  expirationTime: Schema.optional(Schema.NullOr(Schema.Number)),
  keys: PushSubscriptionKeys,
});
export type PushSubscriptionInput = typeof PushSubscriptionInput.Type;

export const PushSubscribeResult = Schema.Struct({ ok: Schema.Boolean });
export type PushSubscribeResult = typeof PushSubscribeResult.Type;

export const PushUnsubscribeInput = Schema.Struct({
  endpoint: TrimmedNonEmptyString.check(Schema.isMaxLength(PUSH_FIELD_MAX_LENGTH)),
});
export type PushUnsubscribeInput = typeof PushUnsubscribeInput.Type;

export const PushUnsubscribeResult = Schema.Struct({ ok: Schema.Boolean });
export type PushUnsubscribeResult = typeof PushUnsubscribeResult.Type;

export const PushStatusInput = Schema.Struct({});
export type PushStatusInput = typeof PushStatusInput.Type;

export const PushStatusResult = Schema.Struct({
  // Whether the server can send pushes (VAPID configured) and the public key the
  // browser needs to create a subscription.
  enabled: Schema.Boolean,
  vapidPublicKey: Schema.optional(TrimmedNonEmptyString),
});
export type PushStatusResult = typeof PushStatusResult.Type;

export class PushError extends Schema.TaggedErrorClass<PushError>()("PushError", {
  message: TrimmedNonEmptyString,
  cause: Schema.optional(Schema.Defect()),
}) {}
