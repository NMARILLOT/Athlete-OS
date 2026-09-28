import type { ReactNode } from "react";

export function Empty({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="rounded-2xl border border-dashed border-border px-4 py-8 text-center text-fg-muted">
      <p className="font-medium text-fg">{title}</p>
      {children ? <div className="mt-2 text-sm">{children}</div> : null}
    </div>
  );
}
