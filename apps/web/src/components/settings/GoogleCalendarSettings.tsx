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
                  ? "Google Calendar has not been enabled on this server yet. Ask the server operator to enable it, then refresh."
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
