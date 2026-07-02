import { ChevronDown } from "lucide-react";
import type { ComponentProps } from "react";
import { cn } from "@/lib/utils";

// Styled native <select> — value text + a chevron, matching the mockup's selects.
export function Select({ className, children, ...props }: ComponentProps<"select">) {
  return (
    <div className="relative inline-flex">
      <select
        className={cn(
          "h-9 w-[120px] cursor-pointer appearance-none rounded-md border border-border-default bg-input pr-8 pl-3 text-sub text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-border",
          className,
        )}
        {...props}
      >
        {children}
      </select>
      <ChevronDown
        aria-hidden="true"
        className="pointer-events-none absolute top-1/2 right-2.5 h-[15px] w-[15px] -translate-y-1/2 text-text-tertiary"
      />
    </div>
  );
}
