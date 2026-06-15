import * as Schema from "effect/Schema";
import { ExternalLinkIcon, GlobeIcon, PlusIcon, XIcon } from "lucide-react";
import { useCallback, useEffect, useState } from "react";

import { getLocalStorageItem, setLocalStorageItem } from "~/hooks/useLocalStorage";
import { cn } from "~/lib/utils";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Popover, PopoverPopup, PopoverTrigger } from "./ui/popover";

const PreviewPortsSchema = Schema.Array(
  Schema.Struct({ port: Schema.Number, path: Schema.String }),
);
type PreviewPort = { readonly port: number; readonly path: string };

function storageKey(cwd: string | null): string {
  return `t3code_preview_ports:${cwd ?? "global"}`;
}

function loadPorts(cwd: string | null): ReadonlyArray<PreviewPort> {
  return getLocalStorageItem(storageKey(cwd), PreviewPortsSchema) ?? [];
}

// Reuse the host the browser reached t3code through (e.g. the Tailscale name/IP)
// and swap in the dev-server port, so the preview rides the same connection.
function buildPreviewUrl(port: number, path: string): string {
  const normalizedPath = path ? (path.startsWith("/") ? path : `/${path}`) : "";
  return `${window.location.protocol}//${window.location.hostname}:${port}${normalizedPath}`;
}

function samePort(a: PreviewPort, b: PreviewPort): boolean {
  return a.port === b.port && a.path === b.path;
}

export function PreviewControl({ cwd }: { cwd: string | null }) {
  const [open, setOpen] = useState(false);
  const [ports, setPorts] = useState<ReadonlyArray<PreviewPort>>(() => loadPorts(cwd));
  const [portInput, setPortInput] = useState("");
  const [pathInput, setPathInput] = useState("");

  useEffect(() => {
    setPorts(loadPorts(cwd));
  }, [cwd]);

  const persist = useCallback(
    (next: ReadonlyArray<PreviewPort>) => {
      setPorts(next);
      setLocalStorageItem(storageKey(cwd), next, PreviewPortsSchema);
    },
    [cwd],
  );

  const openPreview = useCallback((entry: PreviewPort) => {
    window.open(buildPreviewUrl(entry.port, entry.path), "_blank", "noopener,noreferrer");
  }, []);

  const addPort = useCallback(() => {
    const port = Number.parseInt(portInput.trim(), 10);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      return;
    }
    const entry: PreviewPort = { port, path: pathInput.trim() };
    if (!ports.some((existing) => samePort(existing, entry))) {
      persist([...ports, entry]);
    }
    setPortInput("");
    setPathInput("");
    openPreview(entry);
  }, [portInput, pathInput, ports, persist, openPreview]);

  const removePort = useCallback(
    (entry: PreviewPort) => {
      persist(ports.filter((existing) => !samePort(existing, entry)));
    },
    [ports, persist],
  );

  const previewOrigin =
    typeof window === "undefined" ? "" : `${window.location.protocol}//${window.location.hostname}`;

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
                  key={`${entry.port}:${entry.path}`}
                  className="group/preview flex items-center gap-1"
                >
                  <button
                    type="button"
                    className="flex min-w-0 flex-1 items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-accent"
                    onClick={() => openPreview(entry)}
                  >
                    <GlobeIcon className="size-3.5 shrink-0 text-muted-foreground" />
                    <span className="truncate">
                      :{entry.port}
                      {entry.path}
                    </span>
                    <ExternalLinkIcon className="ms-auto size-3 shrink-0 text-muted-foreground/60" />
                  </button>
                  <button
                    type="button"
                    className={cn(
                      "inline-flex size-6 shrink-0 items-center justify-center rounded-sm text-muted-foreground/70",
                      "opacity-0 transition-opacity hover:bg-accent hover:text-foreground group-hover/preview:opacity-100",
                    )}
                    aria-label={`Remove port ${entry.port}`}
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
              inputMode="numeric"
              placeholder="3000"
              aria-label="Port"
              className="w-20"
            />
            <Input
              value={pathInput}
              onChange={(event) => setPathInput(event.target.value)}
              placeholder="/path (optional)"
              aria-label="Path"
              className="min-w-0 flex-1"
            />
            <Button type="submit" size="icon-xs" variant="outline" aria-label="Add and open">
              <PlusIcon className="size-3.5" />
            </Button>
          </form>

          <p className="px-1 text-[11px] leading-snug text-muted-foreground/60">
            Opens {previewOrigin}:&lt;port&gt; in a new tab. Bind dev servers to 0.0.0.0 so they're
            reachable over your connection.
          </p>
        </div>
      </PopoverPopup>
    </Popover>
  );
}
