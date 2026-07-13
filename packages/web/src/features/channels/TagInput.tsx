import { X } from "lucide-react";
import { type KeyboardEvent, useState } from "react";
import { toast } from "sonner";

// Trim + ignore-empty + dedupe a candidate against the existing list — pure so the
// add rule is unit-testable without mounting the component.
export function addTag(tags: string[], raw: string): string[] {
  const trimmed = raw.trim();
  if (trimmed.length === 0 || tags.includes(trimmed)) return tags;
  return [...tags, trimmed];
}

export function removeTag(tags: string[], target: string): string[] {
  return tags.filter((t) => t !== target);
}

interface TagInputProps {
  value: string[];
  onChange: (tags: string[]) => void;
  // Validated before committing — a bad token (comma/space/newline) would reach a
  // mihomo rule and make the engine reject the ENTIRE config reload, so it's blocked
  // here at the write boundary (see domainSchema/keywordSchema in shared).
  validate: (candidate: string) => boolean;
  invalidMessage: string;
  placeholder: string;
  addLabel: string; // aria-label for the draft input
  removeLabel: (tag: string) => string; // aria-label for a chip's × button
  // Optional normalization applied to a candidate before validate + add (e.g.
  // upper-casing GEOIP country codes).
  transform?: (candidate: string) => string;
}

/**
 * Controlled tag-input — measured from the mockup's tag rows: existing values render
 * as removable mono chips (bg-hover, rounded-sm, an × to remove) followed by a plain
 * text field that commits on Enter or blur. A real tag-input, not a comma-separated
 * free-text field — per design-system.md "match the control, don't downgrade it".
 * Shared by DomainTags and KeywordTags (same look; different validation/labels).
 */
export function TagInput({
  value,
  onChange,
  validate,
  invalidMessage,
  placeholder,
  addLabel,
  removeLabel,
  transform,
}: TagInputProps) {
  const [draft, setDraft] = useState("");

  // `notify` is false on the blur path so a single Enter+blur over the same invalid
  // draft doesn't toast twice — Enter already warned, blur just clears silently.
  function commit(notify: boolean) {
    const candidate = (transform ? transform(draft) : draft).trim();
    if (candidate.length === 0) return;
    if (!validate(candidate)) {
      if (notify) toast.error(invalidMessage);
      else setDraft("");
      return;
    }
    const next = addTag(value, candidate);
    if (next !== value) onChange(next);
    setDraft("");
  }

  function onKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Enter") {
      e.preventDefault();
      commit(true);
    }
  }

  return (
    <div className="flex w-full flex-wrap items-center gap-2 rounded-md border border-border-default bg-input px-2.5 py-2">
      {value.map((tag) => (
        <span
          key={tag}
          className="flex items-center gap-[5px] rounded-sm bg-hover px-2 py-1 font-mono text-xs text-text-primary"
        >
          {tag}
          <button
            type="button"
            onClick={() => onChange(removeTag(value, tag))}
            aria-label={removeLabel(tag)}
            className="text-text-tertiary transition-colors hover:text-text-primary"
          >
            <X className="h-3 w-3" aria-hidden="true" />
          </button>
        </span>
      ))}
      <input
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={onKeyDown}
        onBlur={() => commit(false)}
        placeholder={placeholder}
        aria-label={addLabel}
        className="min-w-[100px] flex-1 bg-transparent font-mono text-xs text-text-primary placeholder:text-text-tertiary outline-none"
      />
    </div>
  );
}
