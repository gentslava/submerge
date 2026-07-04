import { CHANNEL_PRESETS } from "@submerge/shared";
import { Check, Plus } from "lucide-react";
import { cn } from "@/lib/utils";

interface PresetChipsProps {
  value: string[];
  onChange: (presets: string[]) => void;
}

/**
 * Toggle-chip group over the shared preset registry (YouTube/Telegram/Discord/Torrent)
 * — measured from the mockup's `Z7zRtE` "Presets" row. Active chips use the accent
 * Badge palette (accent-bg/accent-text/accent-border) with a check icon; inactive
 * chips sit on bg-hover/text-secondary with a plus icon (border-transparent, so the
 * 1px stroke doesn't shift layout on toggle). Real `<button>`s rather than the
 * `Badge` span — chips must stay keyboard/click operable.
 */
export function PresetChips({ value, onChange }: PresetChipsProps) {
  function toggle(id: string) {
    onChange(value.includes(id) ? value.filter((p) => p !== id) : [...value, id]);
  }

  return (
    <div className="flex flex-wrap gap-2">
      {CHANNEL_PRESETS.map((preset) => {
        const active = value.includes(preset.id);
        return (
          <button
            key={preset.id}
            type="button"
            onClick={() => toggle(preset.id)}
            aria-pressed={active}
            className={cn(
              "flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-sub transition-colors",
              active
                ? "border-accent-border bg-accent-bg font-semibold text-accent-text"
                : "border-transparent bg-hover font-medium text-text-secondary",
            )}
          >
            {active ? (
              <Check className="h-[13px] w-[13px]" aria-hidden="true" />
            ) : (
              <Plus className="h-[13px] w-[13px] text-text-tertiary" aria-hidden="true" />
            )}
            {preset.label}
          </button>
        );
      })}
    </div>
  );
}
