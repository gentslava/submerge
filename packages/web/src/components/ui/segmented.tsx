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
  disabled?: boolean;
  stretch?: boolean;
}

export function Segmented({
  options,
  value,
  onChange,
  "aria-label": ariaLabel,
  disabled,
  stretch,
}: SegmentedProps) {
  return (
    // biome-ignore lint/a11y/useSemanticElements: a div with role="group" is the correct ARIA pattern for a segmented switcher; <fieldset> carries unwanted form-control semantics and styling.
    <div
      role="group"
      aria-label={ariaLabel}
      className={cn(
        "segmented-control flex w-full flex-wrap gap-[3px] rounded-md border border-border-subtle bg-canvas p-[3px]",
        stretch && "segmented-control--stretch",
      )}
    >
      {options.map((opt) => {
        const active = opt.value === value;
        return (
          <button
            key={opt.value}
            type="button"
            disabled={disabled}
            onClick={() => onChange(opt.value)}
            aria-current={active ? "true" : undefined}
            className={cn(
              "rounded-sm px-[13px] py-[7px] text-sub font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-border disabled:opacity-50",
              stretch && "flex-1",
              active ? "bg-accent on-accent-fg" : "text-text-secondary hover:text-text-primary",
            )}
          >
            {opt.label}
          </button>
        );
      })}
    </div>
  );
}
