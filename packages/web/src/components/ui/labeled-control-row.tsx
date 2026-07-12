import type { ReactNode } from "react";

export function LabeledControlRow({
  label,
  sub,
  children,
}: {
  label: string;
  sub: string;
  children: ReactNode;
}) {
  return (
    <div className="labeled-control-row flex flex-col gap-2 border-b border-border-subtle px-[18px] py-4 last:border-0">
      <div className="flex min-w-0 flex-col gap-1">
        <span className="text-sm font-medium text-text-primary">{label}</span>
        <span className="text-xs text-text-tertiary">{sub}</span>
      </div>
      <div className="labeled-control-row-control flex w-full items-center gap-2.5">{children}</div>
    </div>
  );
}
