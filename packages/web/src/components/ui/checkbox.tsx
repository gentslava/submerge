import { Check } from "lucide-react";
import { cn } from "@/lib/utils";

interface CheckboxProps {
  checked: boolean;
  onCheckedChange: (v: boolean) => void;
  id?: string;
  disabled?: boolean;
  "aria-label"?: string;
}

// Plain-button checkbox (no native <input>, matching Switch's approach) — measured
// against the channel editor's pool picker (`Z7zRtE`): an 18×18 rounded-sm box,
// border-strong outline when unchecked, solid accent fill + a white check glyph
// when checked.
export function Checkbox({
  checked,
  onCheckedChange,
  id,
  disabled,
  "aria-label": ariaLabel,
}: CheckboxProps) {
  return (
    // biome-ignore lint/a11y/useSemanticElements: plain button by design (matches Switch's role="switch") — the custom box/check-glyph can't be styled from a native <input type="checkbox">.
    <button
      type="button"
      role="checkbox"
      id={id}
      disabled={disabled}
      aria-checked={checked}
      aria-label={ariaLabel}
      onClick={() => onCheckedChange(!checked)}
      className={cn(
        "flex h-[18px] w-[18px] shrink-0 items-center justify-center rounded-sm border-[1.5px] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-border disabled:cursor-not-allowed disabled:opacity-50",
        checked ? "border-accent bg-accent" : "border-border-strong bg-transparent",
      )}
    >
      {checked && <Check className="h-3 w-3 text-accent-fg" aria-hidden="true" />}
    </button>
  );
}
