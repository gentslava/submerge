import { isValidKeyword } from "@submerge/shared";
import { TagInput } from "./TagInput";

interface KeywordTagsProps {
  value: string[];
  onChange: (keywords: string[]) => void;
}

// A channel's DOMAIN-KEYWORD tokens. Thin wrapper over the shared TagInput with
// keyword validation + labels; same look as DomainTags per the mockup.
export function KeywordTags({ value, onChange }: KeywordTagsProps) {
  return (
    <TagInput
      value={value}
      onChange={onChange}
      validate={isValidKeyword}
      invalidMessage="Некорректное слово"
      placeholder="добавить слово…"
      addLabel="Добавить слово"
      removeLabel={(keyword) => `Удалить слово «${keyword}»`}
    />
  );
}
