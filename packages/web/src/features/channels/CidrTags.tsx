import { isValidCidr } from "@submerge/shared";
import { TagInput } from "./TagInput";

interface CidrTagsProps {
  value: string[];
  onChange: (cidrs: string[]) => void;
}

export function CidrTags({ value, onChange }: CidrTagsProps) {
  return (
    <TagInput
      value={value}
      onChange={onChange}
      validate={isValidCidr}
      invalidMessage="Некорректная подсеть CIDR"
      placeholder="добавить CIDR…"
      addLabel="Добавить CIDR"
      removeLabel={(cidr) => `Удалить CIDR «${cidr}»`}
    />
  );
}
