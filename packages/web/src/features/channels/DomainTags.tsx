import { isValidDomain } from "@submerge/shared";
import { X } from "lucide-react";
import { type KeyboardEvent, useState } from "react";
import { toast } from "sonner";

interface DomainTagsProps {
  value: string[];
  onChange: (domains: string[]) => void;
}

// Trim + ignore-empty + dedupe a candidate domain against the existing list — pure
// so the add rule is unit-testable without mounting the component.
export function addDomain(domains: string[], raw: string): string[] {
  const trimmed = raw.trim();
  if (trimmed.length === 0 || domains.includes(trimmed)) return domains;
  return [...domains, trimmed];
}

export function removeDomain(domains: string[], target: string): string[] {
  return domains.filter((d) => d !== target);
}

/**
 * Controlled tag-input for a channel's custom domains — measured from the mockup's
 * `Z7zRtE` "TagInput" row: existing domains render as removable mono chips
 * (bg-hover, rounded-sm, an × to remove) followed by a plain text field that commits
 * a new domain on Enter or blur. A real tag-input, not a comma-separated free-text
 * field — per design-system.md "match the control, don't downgrade it".
 */
export function DomainTags({ value, onChange }: DomainTagsProps) {
  const [draft, setDraft] = useState("");

  // Validates before committing — a malformed domain (comma/space/newline) would
  // reach mihomo's DOMAIN-SUFFIX rule and make the engine reject the ENTIRE config
  // reload (see domainSchema in packages/shared/src/schemas.ts). `notify` is false
  // for the blur path so a single Enter+blur sequence over the same invalid draft
  // doesn't toast twice — Enter already warned, blur just clears silently.
  function commit(notify: boolean) {
    const trimmed = draft.trim();
    if (trimmed.length === 0) return;
    if (!isValidDomain(trimmed)) {
      if (notify) toast.error("Некорректный домен");
      else setDraft("");
      return;
    }
    onChange(addDomain(value, trimmed));
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
      {value.map((domain) => (
        <span
          key={domain}
          className="flex items-center gap-[5px] rounded-sm bg-hover px-2 py-1 font-mono text-xs text-text-primary"
        >
          {domain}
          <button
            type="button"
            onClick={() => onChange(removeDomain(value, domain))}
            aria-label={`Удалить домен «${domain}»`}
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
        placeholder="добавить домен…"
        aria-label="Добавить домен"
        className="min-w-[100px] flex-1 bg-transparent font-mono text-xs text-text-primary placeholder:text-text-tertiary outline-none"
      />
    </div>
  );
}
