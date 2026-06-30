import { cn } from "@/lib/utils";

interface SwitchProps {
  checked: boolean;
  onCheckedChange: (v: boolean) => void;
  id?: string;
  disabled?: boolean;
  "aria-label"?: string;
}

export function Switch({
  checked,
  onCheckedChange,
  id,
  disabled,
  "aria-label": ariaLabel,
}: SwitchProps) {
  return (
    <button
      type="button"
      role="switch"
      id={id}
      disabled={disabled}
      aria-checked={checked}
      aria-label={ariaLabel}
      onClick={() => onCheckedChange(!checked)}
      className={cn(
        // 40×22 track, 16px knob, 3px inset — matches the mockup toggle (a smaller
        // track left too little accent visible and read as washed-out).
        "relative inline-flex h-[22px] w-10 shrink-0 cursor-pointer rounded-full transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-border disabled:opacity-50 disabled:cursor-not-allowed",
        checked ? "bg-accent" : "bg-hover",
      )}
    >
      <span
        className={cn(
          "pointer-events-none absolute top-[3px] left-[3px] h-4 w-4 rounded-full bg-switch-thumb shadow transition-transform",
          checked ? "translate-x-[18px]" : "translate-x-0",
        )}
      />
    </button>
  );
}
