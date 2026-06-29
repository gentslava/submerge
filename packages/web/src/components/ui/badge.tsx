import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

type BadgeVariant = "neutral" | "online" | "slow" | "timeout" | "accent";

const variantClasses: Record<BadgeVariant, string> = {
  neutral: "bg-elevated text-text-secondary",
  online: "bg-online-bg text-online",
  slow: "bg-slow-bg text-slow",
  timeout: "bg-timeout-bg text-timeout",
  accent: "bg-accent-bg text-accent-text",
};

interface BadgeProps {
  variant?: BadgeVariant;
  children: ReactNode;
  className?: string;
}

export function Badge({ variant = "neutral", children, className }: BadgeProps) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-xs font-medium",
        variantClasses[variant],
        className,
      )}
    >
      {children}
    </span>
  );
}
