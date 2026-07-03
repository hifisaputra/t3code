import * as Schema from "effect/Schema";
import { ExternalLinkIcon, GlobeIcon, PlusIcon, XIcon } from "lucide-react";
import { useCallback, useEffect, useState } from "react";

import { getLocalStorageItem, setLocalStorageItem } from "~/hooks/useLocalStorage";
import { cn } from "~/lib/utils";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Popover, PopoverPopup, PopoverTrigger } from "./ui/popover";

// An entry is either a local dev-server port or a full custom URL (e.g. a
// staging domain). Both keep an optional path. The union accepts the legacy
// port-only shape unchanged, so previously saved entries still decode.
const PreviewPortsSchema = Schema.Array(
  Schema.Union([
    Schema.Struct({ port: Schema.Number, path: Schema.String }),
    Schema.Struct({ url: Schema.String, path: Schema.String }),
  ]),
);
type PreviewEntry =
  | { readonly port: number; readonly path: string }
  | { readonly url: string; readonly path: string };

function isUrlEntry(
  entry: PreviewEntry,
): entry is { readonly url: string; readonly path: string } {
  return "url" in entry;
}

function storageKey(cwd: string | null): string {
  return `t3code_preview_ports:${cwd ?? "global"}`;
}

function loadPorts(cwd: string | null): ReadonlyArray<PreviewEntry> {
  return getLocalStorageItem(storageKey(cwd), PreviewPortsSchema) ?? [];
}

function normalizePath(path: string): string {
  return path ? (path.startsWith("/") ? path : `/${path}`) : "";
}

// Reuse the host the browser reached t3code through (e.g. the Tailscale name/IP)
// and swap in the dev-server port, so the preview rides the same connection.
// Force http since most local dev servers don't serve https on their port.
// For custom URLs, keep the given host and default to https when no scheme.
function buildPreviewUrl(entry: PreviewEntry): string {
  if (isUrlEntry(entry)) {
    const hasScheme = /^[a-z][\w+.-]*:\/\//i.test(entry.url);
    const base = (hasScheme ? entry.url : `https://${entry.url}`).replace(/\/+$/, "");
    return `${base}${normalizePath(entry.path)}`;
  }
  return `http://${window.location.hostname}:${entry.port}${normalizePath(entry.path)}`;
}

function entryKey(entry: PreviewEntry): string {
  return isUrlEntry(entry) ? `url:${entry.url}:${entry.path}` : `:${entry.port}:${entry.path}`;
}

function entryLabel(entry: PreviewEntry): string {
  if (isUrlEntry(entry)) {
    return `${entry.url.replace(/^[a-z][\w+.-]*:\/\//i, "").replace(/\/+$/, "")}${entry.path}`;
  }
  return `:${entry.port}${entry.path}`;
}

function sameEntry(a: PreviewEntry, b: PreviewEntry): boolean {
  return entryKey(a) === entryKey(b);
}

export function PreviewControl({ cwd }: { cwd: string | null }) {
  const [open, setOpen] = useState(false);
  const [ports, setPorts] = useState<ReadonlyArray<PreviewEntry>>(() => loadPorts(cwd));
  const [portInput, setPortInput] = useState("");
  const [pathInput, setPathInput] = useState("");

  useEffect(() => {
    setPorts(loadPorts(cwd));
  }, [cwd]);

  const persist = useCallback(
    (next: ReadonlyArray<PreviewEntry>) => {
      setPorts(next);
      setLocalStorageItem(storageKey(cwd), next, PreviewPortsSchema);
    },
    [cwd],
  );

  const openPreview = useCallback((entry: PreviewEntry) => {
    window.open(buildPreviewUrl(entry), "_blank", "noopener,noreferrer");
  }, []);

  const addPort = useCallback(() => {
    const raw = portInput.trim();
    const path = pathInput.trim();
    if (!raw) {
      return;
    }
    let entry: PreviewEntry;
    if (/^\d+$/.test(raw)) {
      const port = Number.parseInt(raw, 10);
      if (!Number.isInteger(port) || port < 1 || port > 65535) {
        return;
      }
      entry = { port, path };
    } else {
      entry = { url: raw, path };
    }
    if (!ports.some((existing) => sameEntry(existing, entry))) {
      persist([...ports, entry]);
    }
    setPortInput("");
    setPathInput("");
    openPreview(entry);
  }, [portInput, pathInput, ports, persist, openPreview]);

  const removePort = useCallback(
    (entry: PreviewEntry) => {
      persist(ports.filter((existing) => !sameEntry(existing, entry)));
    },
    [ports, persist],
  );

  const previewOrigin =
    typeof window === "undefined" ? "" : `http://${window.location.hostname}`;

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={
          <Button
            variant="ghost"
            size="xs"
            className="shrink-0"
            aria-label="Open dev server preview"
          >
            <GlobeIcon className="size-3" />
          </Button>
        }
      />
      <PopoverPopup align="end" className="w-72 p-2">
        <div className="space-y-2">
          <div className="px-1 text-xs font-medium text-muted-foreground">Dev server preview</div>

          {ports.length > 0 ? (
            <div className="space-y-0.5">
              {ports.map((entry) => (
                <div
                  key={entryKey(entry)}
                  className="group/preview flex items-center gap-1"
                >
                  <button
                    type="button"
                    className="flex min-w-0 flex-1 items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-accent"
                    onClick={() => openPreview(entry)}
                  >
                    <GlobeIcon className="size-3.5 shrink-0 text-muted-foreground" />
                    <span className="truncate">{entryLabel(entry)}</span>
                    <ExternalLinkIcon className="ms-auto size-3 shrink-0 text-muted-foreground/60" />
                  </button>
                  <button
                    type="button"
                    className={cn(
                      "inline-flex size-6 shrink-0 items-center justify-center rounded-sm text-muted-foreground/70",
                      "opacity-0 transition-opacity hover:bg-accent hover:text-foreground group-hover/preview:opacity-100",
                    )}
                    aria-label={`Remove ${entryLabel(entry)}`}
                    onClick={() => removePort(entry)}
                  >
                    <XIcon className="size-3.5" />
                  </button>
                </div>
              ))}
            </div>
          ) : (
            <p className="px-1 text-xs text-muted-foreground/70">
              No ports yet. Add the port your dev server runs on.
            </p>
          )}

          <form
            className="flex items-center gap-1"
            onSubmit={(event) => {
              event.preventDefault();
              addPort();
            }}
          >
            <Input
              value={portInput}
              onChange={(event) => setPortInput(event.target.value)}
              placeholder="3000 or staging.site.com"
              aria-label="Port or URL"
              className="min-w-0 flex-1"
            />
            <Input
              value={pathInput}
              onChange={(event) => setPathInput(event.target.value)}
              placeholder="/path"
              aria-label="Path"
              className="w-20 shrink-0"
            />
            <Button type="submit" size="icon-xs" variant="outline" aria-label="Add and open">
              <PlusIcon className="size-3.5" />
            </Button>
          </form>

          <p className="px-1 text-[11px] leading-snug text-muted-foreground/60">
            Enter a port to open {previewOrigin}:&lt;port&gt;, or a full URL/domain (e.g. a staging
            site) to open it directly. Bind dev servers to 0.0.0.0 so they're reachable over your
            connection.
          </p>
        </div>
      </PopoverPopup>
    </Popover>
  );
}
