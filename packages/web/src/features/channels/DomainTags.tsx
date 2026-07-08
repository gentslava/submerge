import { isValidDomain } from "@submerge/shared";
import { addTag, removeTag, TagInput } from "./TagInput";

interface DomainTagsProps {
  value: string[];
  onChange: (domains: string[]) => void;
}

// Kept as named exports for existing unit tests — the add/remove rule is the shared
// tag logic (trim + ignore-empty + dedupe).
export const addDomain = addTag;
export const removeDomain = removeTag;

// A channel's custom domains (DOMAIN-SUFFIX). Thin wrapper over the shared TagInput
// with domain validation + labels.
export function DomainTags({ value, onChange }: DomainTagsProps) {
  return (
    <TagInput
      value={value}
      onChange={onChange}
      validate={isValidDomain}
      invalidMessage="Некорректный домен"
      placeholder="добавить домен…"
      addLabel="Добавить домен"
      removeLabel={(domain) => `Удалить домен «${domain}»`}
    />
  );
}
