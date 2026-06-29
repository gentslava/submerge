import type { ComponentProps } from "react";
import { cn } from "@/lib/utils";

export function Textarea({ className, ref, ...props }: ComponentProps<"textarea">) {
  return (
    <textarea
      ref={ref}
      className={cn(
        "min-h-24 w-full bg-input border border-border-default rounded-md px-3 py-2 text-sm font-mono text-text-primary placeholder:text-text-tertiary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-border",
        className,
      )}
      {...props}
    />
  );
}
