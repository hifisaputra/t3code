import { usePrimarySettings } from "~/hooks/useSettings";
import { serverEnvironment } from "~/state/server";
import { Input } from "../ui/input";
import { useState } from "react";
import { ensureLocalApi } from "~/localApi";
import { usePrimaryEnvironment } from "~/state/environments";
import { googleCalendarEnvironment as calendar } from "~/state/googleCalendar";
import { useEnvironmentQuery } from "~/state/query";
import { useAtomCommand } from "~/state/use-atom-command";
import { Button } from "../ui/button";
import { SettingsRow, SettingsSection } from "./settingsLayout";

export function GoogleCalendarSettingsSection() {
  const environmentId = usePrimaryEnvironment()?.environmentId ?? null;
  const status = useEnvironmentQuery(
    environmentId ? calendar.status({ environmentId, input: {} }) : null,
  );
  const authorize = useAtomCommand(calendar.authorize);
  const disconnect = useAtomCommand(calendar.disconnect);
  const [busy, setBusy] = useState(false);
  const [authorizationUrl, setAuthorizationUrl] = useState<string | null>(null);
  const [openError, setOpenError] = useState<string | null>(null);

  return (
    <SettingsSection id="google-calendar" title="Google Calendar">
      <GoogleOAuthSettings
        key={environmentId}
        onSaved={() => {
          setAuthorizationUrl(null);
          status.refresh();
        }}
      />
      <SettingsRow
        serverScoped
        title="Connection"
        description="Plan Linear issues in your calendar, then start or resume their T3 threads. This connection belongs to this environment."
        control={
          <div className="flex flex-wrap items-center gap-2">
            <Button
              size="sm"
              variant="outline"
              disabled={busy || status.isPending}
              onClick={() => {
                status.refresh();
                setAuthorizationUrl(null);
              }}
            >
              Refresh
            </Button>
            <Button
              size="sm"
              disabled={!environmentId || !status.data?.configured || busy}
              onClick={async () => {
                if (!environmentId) return;
                setBusy(true);
                try {
                  const result = await authorize({ environmentId, input: {} });
                  if (result._tag === "Success") setAuthorizationUrl(result.value.url);
                } finally {
                  setBusy(false);
                }
              }}
            >
              {status.data?.connected ? "Reconnect" : "Connect"}
            </Button>
            {status.data?.connected ? (
              <Button
                size="sm"
                variant="outline"
                disabled={busy}
                onClick={async () => {
                  if (!environmentId) return;
                  setBusy(true);
                  try {
                    const result = await disconnect({ environmentId, input: {} });
                    if (result._tag === "Success") {
                      setAuthorizationUrl(null);
                      status.refresh();
                    }
                  } finally {
                    setBusy(false);
                  }
                }}
              >
                Disconnect
              </Button>
            ) : null}
          </div>
        }
      >
        <p className="text-sm text-muted-foreground" role="status">
          {status.error ??
            (status.isPending
              ? "Checking connection…"
              : !environmentId
                ? "Connect to an environment first."
                : !status.data?.configured
                  ? "Save the Google OAuth client ID, secret, and callback URL above to enable Connect."
                  : status.data.connected
                    ? "Connected. Open Issues → Agenda to plan your work."
                    : "Not connected.")}
        </p>
        {authorizationUrl ? (
          <div className="mt-2 space-y-2 text-sm">
            <Button
              size="sm"
              onClick={() => {
                setOpenError(null);
                void ensureLocalApi()
                  .shell.openExternal(authorizationUrl)
                  .catch(() =>
                    setOpenError("Could not open Google. Try opening the connection link again."),
                  );
              }}
            >
              Continue to Google
            </Button>
            <p className="text-muted-foreground">
              After allowing access in Google, return here and click Refresh.
            </p>
            {openError ? <p role="alert">{openError}</p> : null}
          </div>
        ) : null}
      </SettingsRow>
    </SettingsSection>
  );
}

function GoogleOAuthSettings({ onSaved }: { onSaved: () => void }) {
  const environmentId = usePrimaryEnvironment()?.environmentId;
  const saved = usePrimarySettings((s) => s.googleCalendar);
  const update = useAtomCommand(serverEnvironment.updateSettings);
  const [clientId, setClientId] = useState(saved.clientId);
  const [redirectUri, setRedirectUri] = useState(saved.redirectUri);
  const [clientSecret, setClientSecret] = useState("");
  const [previous, setPrevious] = useState(saved);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (
    previous.clientId !== saved.clientId ||
    previous.redirectUri !== saved.redirectUri ||
    previous.clientSecret !== saved.clientSecret
  ) {
    setPrevious(saved);
    setClientId(saved.clientId);
    setRedirectUri(saved.redirectUri);
    setClientSecret("");
  }
  const persist = async (removeSecret = false) => {
    if (!environmentId) return;
    setBusy(true);
    setError(null);
    try {
      const result = await update({
        environmentId,
        input: {
          patch: {
            googleCalendar: removeSecret
              ? { clientSecret: "" }
              : {
                  clientId: clientId.trim(),
                  redirectUri: redirectUri.trim(),
                  ...(clientSecret.trim() ? { clientSecret: clientSecret.trim() } : {}),
                },
          },
        },
      });
      if (result._tag === "Success") {
        setClientSecret("");
        onSaved();
      } else setError("Could not save Google OAuth settings. Try again.");
    } finally {
      setBusy(false);
    }
  };
  return (
    <SettingsRow
      serverScoped
      title="Google OAuth application"
      description="Create a Web application client in Google Cloud with the Calendar API enabled. Register the exact callback URL below. Changes apply immediately; changing the client ID requires reconnecting."
      control={
        <div className="flex gap-2">
          <Button size="sm" disabled={!environmentId || busy} onClick={() => void persist()}>
            Save
          </Button>
          {saved.clientSecret ? (
            <Button
              size="sm"
              variant="outline"
              disabled={!environmentId || busy}
              onClick={() => void persist(true)}
            >
              Remove secret
            </Button>
          ) : null}
        </div>
      }
    >
      <div className="mt-2 grid gap-3">
        <label className="grid gap-1 text-sm">
          Google client ID
          <Input
            autoComplete="off"
            value={clientId}
            disabled={busy}
            onChange={(e) => setClientId(e.target.value)}
          />
        </label>
        <label className="grid gap-1 text-sm">
          Google client secret
          <Input
            type="password"
            autoComplete="off"
            value={clientSecret}
            disabled={busy}
            placeholder={saved.clientSecret ? "Saved; enter to replace" : "Client secret"}
            onChange={(e) => setClientSecret(e.target.value)}
          />
        </label>
        <label className="grid gap-1 text-sm">
          Google callback URL
          <Input
            type="url"
            value={redirectUri}
            disabled={busy}
            placeholder="https://your-server/oauth/google-calendar/callback"
            onChange={(e) => setRedirectUri(e.target.value)}
          />
        </label>
        <p className="text-sm text-muted-foreground">
          Use your server’s public URL followed by /oauth/google-calendar/callback. The secret stays
          on the server. Leave it blank to keep the saved secret.
        </p>
        {error ? (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        ) : null}
      </div>
    </SettingsRow>
  );
}
