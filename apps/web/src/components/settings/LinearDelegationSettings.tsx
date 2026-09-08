import { searchableSetting } from "./settingsSearch";
import { DEFAULT_CLIENT_SETTINGS, type LinearDelegationSettings } from "@t3tools/contracts";
import { createModelSelection } from "@t3tools/shared/model";
import { useState } from "react";
import { usePrimarySettings, useUpdatePrimarySettings } from "~/hooks/useSettings";
import { ensureLocalApi } from "~/localApi";
import { getCustomModelOptionsByInstance } from "~/modelSelection";
import {
  deriveProviderInstanceEntries,
  resolveDefaultProviderModelSelection,
} from "~/providerInstances";
import { usePrimaryEnvironment } from "~/state/environments";
import { linearEnvironment } from "~/state/linear";
import { useEnvironmentQuery } from "~/state/query";
import { useAtomCommand } from "~/state/use-atom-command";
import { ProviderModelPicker } from "../chat/ProviderModelPicker";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Switch } from "../ui/switch";
import { SettingsRow } from "./settingsLayout";

export function LinearDelegationSettingsSection() {
  const environment = usePrimaryEnvironment();
  const environmentId = environment?.environmentId;
  const settings = usePrimarySettings((s) => s);
  const saved = settings.linear.delegation;
  const update = useUpdatePrimarySettings();
  const patch = (delegation: Partial<LinearDelegationSettings>) =>
    update({ linear: { delegation } });
  const status = useEnvironmentQuery(
    environmentId ? linearEnvironment.delegationStatus({ environmentId, input: {} }) : null,
  );
  const authorize = useAtomCommand(linearEnvironment.delegationAuthorize);
  const disconnect = useAtomCommand(linearEnvironment.delegationDisconnect);
  const [url, setUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const providers = environment?.serverConfig?.providers ?? [];
  const selection = resolveDefaultProviderModelSelection(providers, saved.modelSelection);
  const entries = deriveProviderInstanceEntries(providers);
  const options = getCustomModelOptionsByInstance(
    { ...DEFAULT_CLIENT_SETTINGS, ...settings },
    providers,
    selection?.instanceId,
    selection?.model,
  );
  return (
    <>
      <SettingsRow
        serverScoped
        {...searchableSetting("linear-delegation")}
        description="Let teammates delegate issues or mention T3 Code in Linear to start work on this environment. Allowed teams use this machine’s repositories and provider credentials."
        control={
          <Switch
            checked={saved.enabled}
            disabled={!status.data?.connected || !saved.modelSelection}
            onCheckedChange={(enabled) =>
              update({
                linear: { delegation: { enabled }, ...(enabled ? { agentAccess: true } : {}) },
              })
            }
          />
        }
      />
      <DelegationField
        title="Public environment URL"
        value={saved.publicUrl}
        onSave={(publicUrl) => patch({ publicUrl })}
      />
      <DelegationField
        title="Linear app client ID"
        value={saved.clientId}
        onSave={(clientId) => patch({ clientId })}
      />
      <DelegationField
        title="Linear app client secret"
        secret
        value={saved.clientSecret}
        onSave={(clientSecret) => patch({ clientSecret })}
      />
      <DelegationField
        title="Linear webhook secret"
        secret
        value={saved.webhookSecret}
        onSave={(webhookSecret) => patch({ webhookSecret })}
      />
      <SettingsRow
        serverScoped
        title="Linear agent connection"
        description="Create a Linear OAuth app named T3 Code and enable Agent session events. Then connect as a Linear workspace admin."
        control={
          <div className="flex gap-2">
            <Button size="sm" variant="outline" onClick={() => status.refresh()}>
              Refresh
            </Button>
            <Button
              size="sm"
              disabled={busy || !environmentId}
              onClick={async () => {
                if (!environmentId) return;
                setBusy(true);
                setError(null);
                try {
                  const result = await authorize({ environmentId, input: {} });
                  if (result._tag === "Success") setUrl(result.value.url);
                  else setError("Could not authorize. Check the saved app settings.");
                } finally {
                  setBusy(false);
                }
              }}
            >
              {status.data?.connected ? "Reconnect" : "Connect"}
            </Button>
            {status.data?.connected && (
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
                      setUrl(null);
                      status.refresh();
                    } else setError("Could not disconnect the app.");
                  } finally {
                    setBusy(false);
                  }
                }}
              >
                Disconnect
              </Button>
            )}
          </div>
        }
      >
        <p className="text-sm text-muted-foreground" role="status">
          {error ??
            status.error ??
            (status.data?.connected ? "Connected to Linear as an app." : "Not connected.")}
        </p>
        {saved.publicUrl && (
          <div className="mt-2 break-all text-xs text-muted-foreground">
            <p>OAuth callback: {saved.publicUrl.replace(/\/$/, "")}/api/linear/oauth/callback</p>
            <p>Webhook: {saved.publicUrl.replace(/\/$/, "")}/api/webhooks/linear</p>
          </div>
        )}
        {url && (
          <Button
            size="sm"
            className="mt-2"
            onClick={() => {
              void ensureLocalApi()
                .shell.openExternal(url)
                .catch(() => setError("Could not open Linear authorization."));
            }}
          >
            Open Linear authorization
          </Button>
        )}
      </SettingsRow>
      <SettingsRow
        serverScoped
        title="Delegation model"
        description="Choose the provider and model that will run delegated issues."
        control={
          selection ? (
            <ProviderModelPicker
              activeInstanceId={selection.instanceId}
              model={selection.model}
              lockedProvider={null}
              instanceEntries={entries}
              modelOptionsByInstance={options}
              onInstanceModelChange={(instanceId, model) =>
                patch({ modelSelection: createModelSelection(instanceId, model) })
              }
            />
          ) : (
            <span className="text-sm">Configure a provider first.</span>
          )
        }
      >
        {!saved.modelSelection && selection && (
          <Button size="sm" variant="outline" onClick={() => patch({ modelSelection: selection })}>
            Use this model for delegation
          </Button>
        )}
      </SettingsRow>
      <SettingsRow
        serverScoped
        title="Run without permission prompts"
        description="Full access lets delegated agents run commands unattended. Otherwise permission requests are relayed to Linear for approval."
        control={
          <Switch
            checked={saved.runtimeMode === "full-access"}
            onCheckedChange={(checked) =>
              patch({ runtimeMode: checked ? "full-access" : "approval-required" })
            }
          />
        }
      />
      <DelegationField
        title="Allowed Linear teams"
        value={saved.allowedTeamKeys.join(", ")}
        onSave={(value) =>
          patch({
            allowedTeamKeys: value
              .split(/[\s,]+/)
              .map((s) => s.trim().toUpperCase())
              .filter(Boolean),
          })
        }
        description="Comma-separated team keys. Leave empty to allow all teams the app can access. Repository mappings above also apply to delegation."
      />
    </>
  );
}
function DelegationField({
  title,
  value,
  secret = false,
  onSave,
  description,
}: {
  title: string;
  value: string;
  secret?: boolean;
  onSave: (value: string) => void;
  description?: string;
}) {
  const [draft, setDraft] = useState(secret ? "" : value);
  const [previous, setPrevious] = useState(value);
  if (previous !== value) {
    setPrevious(value);
    setDraft(secret ? "" : value);
  }
  return (
    <SettingsRow
      serverScoped
      title={title}
      description={description}
      control={
        <div className="flex gap-2">
          <Input
            aria-label={title}
            type={secret ? "password" : "text"}
            autoComplete="off"
            value={draft}
            placeholder={secret && value ? "Saved; enter to replace" : ""}
            onChange={(e) => setDraft(e.target.value)}
          />
          <Button
            size="sm"
            variant="outline"
            disabled={secret && !draft}
            onClick={() => {
              onSave(draft.trim());
              if (secret) setDraft("");
            }}
          >
            Save
          </Button>
          {secret && value && (
            <Button size="sm" variant="ghost" onClick={() => onSave("")}>
              Remove
            </Button>
          )}
        </div>
      }
    />
  );
}
