import { cva, type VariantProps } from "class-variance-authority";
import type { ComponentPropsWithRef } from "react";
import { cn } from "@/lib/utils";

const button = cva(
  "inline-flex items-center justify-center gap-2 rounded-md text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-border disabled:opacity-50 disabled:pointer-events-none cursor-pointer",
  {
    variants: {
      variant: {
        primary: "bg-accent text-accent-fg hover:bg-accent-hover",
        // Bright label (text-primary) + muted icon (text-secondary) per the mockup —
        // a fully-muted label made these read as "disabled".
        secondary:
          "bg-elevated text-text-primary border border-border-default hover:bg-hover [&_svg]:text-text-secondary",
        ghost: "bg-transparent text-text-secondary hover:bg-hover",
        destructive: "bg-timeout-bg text-timeout hover:bg-timeout-bg/80",
      },
      size: {
        sm: "h-8 px-[14px] text-sub",
        md: "h-10 px-[14px]",
        icon: "h-9 w-9 p-0",
      },
    },
    defaultVariants: { variant: "primary", size: "md" },
  },
);

export type ButtonProps = ComponentPropsWithRef<"button"> & VariantProps<typeof button>;

export function Button({ className, variant, size, ...props }: ButtonProps) {
  return <button className={cn(button({ variant, size }), className)} {...props} />;
}
