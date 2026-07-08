import { CHANNEL_PRESETS, PRESET_DOMAINS } from "@submerge/shared";
import { Check, Plus } from "lucide-react";
import { cn } from "@/lib/utils";

interface PresetChipsProps {
  value: string[];
  onChange: (presets: string[]) => void;
}

// Groups CHANNEL_PRESETS by `category`, preserving each preset's registry order
// within its group and first-seen order across groups. Computed once at module
// scope (not per render) since CHANNEL_PRESETS is a static `as const` array —
// with the registry only growing over time, redoing this on every chip toggle
// would be pure waste for a result that's always the same.
const GROUPED_PRESETS: { category: string; presets: (typeof CHANNEL_PRESETS)[number][] }[] = [];
for (const preset of CHANNEL_PRESETS) {
  const group = GROUPED_PRESETS.find((g) => g.category === preset.category);
  if (group) group.presets.push(preset);
  else GROUPED_PRESETS.push({ category: preset.category, presets: [preset] });
}

/**
 * Toggle-chip groups over the shared preset registry, one labeled row per category
 * (Видео/Мессенджеры/AI/Соцсети/Стриминг/Гейминг/P2P) — measured from the mockup's
 * `Z7zRtE` "Presets" row, extended with an uppercase group caption since the
 * registry now holds one preset per service rather than one per category. Active
 * chips use the accent Badge palette (accent-bg/accent-text/accent-border) with a
 * check icon; inactive chips sit on bg-hover/text-secondary with a plus icon
 * (border-transparent, so the 1px stroke doesn't shift layout on toggle). Real
 * `<button>`s rather than the `Badge` span — chips must stay keyboard/click operable.
 * Each chip carries a native `title` listing the preset's domains — a zero-JS,
 * accessible hover/focus tooltip surfacing exactly what traffic the chip routes.
 */
export function PresetChips({ value, onChange }: PresetChipsProps) {
  function toggle(id: string) {
    onChange(value.includes(id) ? value.filter((p) => p !== id) : [...value, id]);
  }

  return (
    <div className="flex flex-col gap-2.5">
      {GROUPED_PRESETS.map(({ category, presets }) => (
        <div key={category} className="flex flex-col gap-1.5">
          <span className="text-fine font-semibold uppercase tracking-wide text-text-tertiary">
            {category}
          </span>
          <div className="flex flex-wrap gap-2">
            {presets.map((preset) => {
              const active = value.includes(preset.id);
              return (
                <button
                  key={preset.id}
                  type="button"
                  onClick={() => toggle(preset.id)}
                  aria-pressed={active}
                  title={`${preset.label}\n${PRESET_DOMAINS[preset.id].join("\n")}`}
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
        </div>
      ))}
    </div>
  );
}
