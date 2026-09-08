import { ChevronRightIcon } from "lucide-react";
import { useState, type ReactNode } from "react";

export function IntegrationSetup({
  title,
  configured,
  children,
}: {
  title: string;
  configured: boolean;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(!configured);
  const [previousConfigured, setPreviousConfigured] = useState(configured);
  if (previousConfigured !== configured) {
    setPreviousConfigured(configured);
    setOpen(!configured);
  }
  return (
    <details
      className="group/setup"
      open={open}
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary className="flex cursor-pointer list-none items-center gap-2 rounded-lg px-3 py-3 text-sm focus-visible:outline-2 focus-visible:outline-ring sm:px-4 [&::-webkit-details-marker]:hidden">
        <ChevronRightIcon className="size-4 text-muted-foreground group-open/setup:rotate-90" />
        <span className="flex-1">{title}</span>
        <span className="text-xs text-muted-foreground">
          {configured ? "Configured" : "Setup required"}
        </span>
      </summary>
      <div className="border-t border-border/50 bg-muted/15 [&>*+*]:border-t [&>*+*]:border-border/50">
        {children}
      </div>
    </details>
  );
}
