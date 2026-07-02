import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

// Status/label variants carry their own fill + text (and dot, supplied by the
// caller as a child). `mono` is a distinct style for type tags ("VLESS"): a
// monospace pill on bg-hover, no dot.
type BadgeVariant = "neutral" | "idle" | "online" | "slow" | "timeout" | "accent" | "mono";

const variantClasses: Record<BadgeVariant, string> = {
  neutral: "bg-elevated text-text-secondary",
  idle: "bg-hover text-text-secondary",
  online: "bg-online-bg text-online",
  slow: "bg-slow-bg text-slow",
  timeout: "bg-timeout-bg text-timeout",
  accent: "bg-accent-bg text-accent-text",
  mono: "bg-hover text-text-secondary font-mono text-fine",
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
        "inline-flex items-center gap-1.5 rounded-full px-2 py-[3px] text-xs font-medium",
        variantClasses[variant],
        className,
      )}
    >
      {children}
    </span>
  );
}
