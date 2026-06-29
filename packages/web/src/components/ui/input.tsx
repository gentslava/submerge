import type { ComponentProps } from "react";
import { cn } from "@/lib/utils";

export function Input({ className, ref, ...props }: ComponentProps<"input">) {
  return (
    <input
      ref={ref}
      className={cn(
        "h-9 w-full bg-input border border-border-default rounded-md px-3 text-sm text-text-primary placeholder:text-text-tertiary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-border",
        className,
      )}
      {...props}
    />
  );
}
