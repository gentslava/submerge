import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

interface PageHeaderProps {
  title: ReactNode;
  subtitle: ReactNode;
  actions?: ReactNode;
  className?: string;
  actionsClassName?: string;
  subtitleClassName?: string;
}

export function PageHeader({
  title,
  subtitle,
  actions,
  className,
  actionsClassName,
  subtitleClassName,
}: PageHeaderProps) {
  return (
    <header
      className={cn("page-header flex min-w-0 items-center justify-between gap-4", className)}
    >
      <div className="page-header-copy flex min-w-0 flex-col gap-0.5">
        <h1 className="page-header-title text-page-title-compact text-text-primary">{title}</h1>
        <p
          className={cn(
            "page-header-subtitle truncate text-xs font-normal text-text-tertiary",
            subtitleClassName,
          )}
        >
          {subtitle}
        </p>
      </div>
      {actions != null && (
        <div
          className={cn("page-header-actions flex shrink-0 items-center gap-2", actionsClassName)}
        >
          {actions}
        </div>
      )}
    </header>
  );
}
