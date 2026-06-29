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
      className="inline-flex rounded-lg border border-border-default bg-elevated p-0.5"
    >
      {options.map((opt) => (
        <button
          key={opt.value}
          type="button"
          onClick={() => onChange(opt.value)}
          className={cn(
            "min-h-8 rounded-md px-3 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-border",
            opt.value === value
              ? "bg-surface text-text-primary shadow-sm"
              : "text-text-secondary hover:text-text-primary",
          )}
        >
          {opt.label}
        </button>
      ))}
    </div>
  );
}
