import { cn } from "@/lib/utils";

interface SegmentedOption {
  value: string;
  label: string;
}

interface SegmentedProps {
  options: SegmentedOption[];
  value: string;
  onChange: (v: string) => void;
  "aria-label"?: string;
}

export function Segmented({ options, value, onChange, "aria-label": ariaLabel }: SegmentedProps) {
  return (
    // biome-ignore lint/a11y/useSemanticElements: a div with role="group" is the correct ARIA pattern for a segmented switcher; <fieldset> carries unwanted form-control semantics and styling.
    <div
      role="group"
      aria-label={ariaLabel}
      className="inline-flex gap-[3px] rounded-md border border-border-subtle bg-canvas p-[3px]"
    >
      {options.map((opt) => {
        const active = opt.value === value;
        return (
          <button
            key={opt.value}
            type="button"
            onClick={() => onChange(opt.value)}
            aria-current={active ? "true" : undefined}
            className={cn(
              "rounded-sm px-[13px] py-[7px] text-sub font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-border",
              active ? "bg-accent text-accent-fg" : "text-text-secondary hover:text-text-primary",
            )}
          >
            {opt.label}
          </button>
        );
      })}
    </div>
  );
}
