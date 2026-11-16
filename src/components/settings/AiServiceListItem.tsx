"use client";

import type { ReactNode } from "react";

/** A quiet service entry; connection state remains in the calling controller. */
export default function AiServiceListItem({ icon, name, description, action, onDetails }: {
  icon: ReactNode;
  name: string;
  description: string;
  action?: ReactNode;
  onDetails?: () => void;
}) {
  return (
    <div className="flex min-h-20 min-w-0 items-center gap-3 rounded-xl border border-border/70 bg-card px-3 py-4 transition-colors hover:bg-muted/30">
      <span aria-hidden="true" className="flex size-8 shrink-0 items-center justify-center rounded-full bg-white text-sm font-semibold text-slate-950">{icon}</span>
      <div className="min-w-0 flex-1">
        {onDetails ? (
          <button type="button" title={name} onClick={onDetails} className="max-w-full truncate rounded-sm text-left text-sm font-semibold hover:underline focus-visible:outline-2 focus-visible:outline-ring">{name}</button>
        ) : <p title={name} className="truncate text-sm font-semibold">{name}</p>}
        <p title={description} className="truncate text-xs leading-5 text-muted-foreground">{description}</p>
      </div>
      {action && <div className="flex shrink-0 items-center gap-1">{action}</div>}
    </div>
  );
}
