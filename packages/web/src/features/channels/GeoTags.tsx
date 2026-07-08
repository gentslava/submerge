import { isValidGeoCategory, isValidGeoCountry } from "@submerge/shared";
import { TagInput } from "./TagInput";

interface GeoTagsProps {
  value: string[];
  onChange: (values: string[]) => void;
}

// GEOSITE categories (lowercase tokens from geosite.dat, e.g. youtube, telegram).
export function GeoSiteTags({ value, onChange }: GeoTagsProps) {
  return (
    <TagInput
      value={value}
      onChange={onChange}
      validate={isValidGeoCategory}
      invalidMessage="Некорректная категория"
      placeholder="youtube, telegram…"
      addLabel="Добавить категорию GEOSITE"
      removeLabel={(cat) => `Удалить категорию «${cat}»`}
    />
  );
}

// GEOIP country codes (ISO alpha-2, upper-cased on entry, e.g. RU, CN; plus LAN/PRIVATE).
export function GeoIpTags({ value, onChange }: GeoTagsProps) {
  return (
    <TagInput
      value={value}
      onChange={onChange}
      validate={isValidGeoCountry}
      invalidMessage="Некорректный код страны"
      placeholder="RU, CN…"
      addLabel="Добавить код GEOIP"
      removeLabel={(code) => `Удалить код «${code}»`}
      transform={(s) => s.toUpperCase()}
    />
  );
}
