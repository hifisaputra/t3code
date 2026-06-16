import type { EnvironmentId } from "@t3tools/contracts";
import { BellIcon, BellOffIcon } from "lucide-react";
import { useCallback, useEffect, useState } from "react";

import { readEnvironmentConnection } from "../environments/runtime";
import { Button } from "./ui/button";
import { Popover, PopoverPopup, PopoverTrigger } from "./ui/popover";

const PUSH_SW_URL = "/push-sw.js";

function isPushSupported(): boolean {
  return (
    typeof window !== "undefined" &&
    "serviceWorker" in navigator &&
    "PushManager" in window &&
    "Notification" in window
  );
}

// VAPID public keys are base64url; PushManager wants a Uint8Array application key.
function urlBase64ToUint8Array(base64String: string): Uint8Array<ArrayBuffer> {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(base64);
  const output = new Uint8Array(new ArrayBuffer(raw.length));
  for (let index = 0; index < raw.length; index += 1) {
    output[index] = raw.charCodeAt(index);
  }
  return output;
}

export function NotificationsControl({ environmentId }: { environmentId: EnvironmentId }) {
  const supported = isPushSupported();
  const [open, setOpen] = useState(false);
  const [permission, setPermission] = useState<NotificationPermission>(
    supported ? Notification.permission : "denied",
  );
  const [subscribed, setSubscribed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!supported) {
      return;
    }
    let cancelled = false;
    void navigator.serviceWorker
      .getRegistration()
      .then((registration) => registration?.pushManager.getSubscription() ?? null)
      .then((subscription) => {
        if (!cancelled) {
          setSubscribed(Boolean(subscription));
        }
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [supported]);

  const pushClient = useCallback(
    () => readEnvironmentConnection(environmentId)?.client.push ?? null,
    [environmentId],
  );

  const enable = useCallback(async () => {
    setError(null);
    setBusy(true);
    try {
      const client = pushClient();
      if (!client) {
        throw new Error("Not connected to the server.");
      }
      const result = await Notification.requestPermission();
      setPermission(result);
      if (result !== "granted") {
        return;
      }
      const status = await client.getStatus();
      if (!status.enabled || !status.vapidPublicKey) {
        throw new Error("Server push is not configured.");
      }
      const registration = await navigator.serviceWorker.register(PUSH_SW_URL);
      // register() resolves once the worker is installed, but pushManager.subscribe()
      // requires an *active* worker — otherwise the first enable fails with
      // "Subscription failed - no active Service Worker". Wait for activation.
      const activeRegistration = registration.active
        ? registration
        : await navigator.serviceWorker.ready;
      const subscription = await activeRegistration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(status.vapidPublicKey),
      });
      const json = subscription.toJSON();
      if (!json.endpoint || !json.keys?.p256dh || !json.keys?.auth) {
        throw new Error("Browser returned an invalid subscription.");
      }
      await client.subscribe({
        endpoint: json.endpoint,
        keys: { p256dh: json.keys.p256dh, auth: json.keys.auth },
        ...(typeof json.expirationTime === "number" ? { expirationTime: json.expirationTime } : {}),
      });
      setSubscribed(true);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Failed to enable notifications.");
    } finally {
      setBusy(false);
    }
  }, [pushClient]);

  const disable = useCallback(async () => {
    setError(null);
    setBusy(true);
    try {
      const registration = await navigator.serviceWorker.getRegistration();
      const subscription = (await registration?.pushManager.getSubscription()) ?? null;
      if (subscription) {
        const endpoint = subscription.endpoint;
        await subscription.unsubscribe();
        await pushClient()?.unsubscribe({ endpoint });
      }
      setSubscribed(false);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Failed to disable notifications.");
    } finally {
      setBusy(false);
    }
  }, [pushClient]);

  if (!supported) {
    return null;
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={
          <Button variant="ghost" size="xs" className="shrink-0" aria-label="Notifications">
            {subscribed ? <BellIcon className="size-3" /> : <BellOffIcon className="size-3" />}
          </Button>
        }
      />
      <PopoverPopup align="end" className="w-72 p-3">
        <div className="space-y-2">
          <div className="text-xs font-medium text-muted-foreground">Notifications</div>
          {permission === "denied" ? (
            <p className="text-xs text-muted-foreground/80">
              Notifications are blocked. Enable them for this site in your browser settings, then
              try again.
            </p>
          ) : subscribed ? (
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="w-full"
              disabled={busy}
              onClick={() => void disable()}
            >
              Disable notifications
            </Button>
          ) : (
            <Button
              type="button"
              size="sm"
              className="w-full"
              disabled={busy}
              onClick={() => void enable()}
            >
              Enable notifications
            </Button>
          )}
          {error ? <p className="text-xs text-destructive">{error}</p> : null}
          <p className="text-[11px] leading-snug text-muted-foreground/60">
            Get pinged when an agent finishes or needs approval — even with the tab closed. On a
            phone, add this site to your home screen first for reliable delivery.
          </p>
        </div>
      </PopoverPopup>
    </Popover>
  );
}
