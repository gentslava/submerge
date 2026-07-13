import type { DirectChannel, UpdateDirectInput } from "@submerge/shared";
import type { ReactNode } from "react";
import { Switch } from "@/components/ui/switch";
import { CidrTags } from "./CidrTags";
import { DomainTags } from "./DomainTags";
import { GeoIpTags, GeoSiteTags } from "./GeoTags";
import { KeywordTags } from "./KeywordTags";
import { PresetChips } from "./PresetChips";
import { RuleProviderRows } from "./RuleProviderRows";

interface DirectChannelEditorProps {
  channel: DirectChannel;
  onChange: (patch: UpdateDirectInput) => void;
  disabled?: boolean;
}

export function DirectChannelEditor({ channel, onChange, disabled }: DirectChannelEditorProps) {
  const emitChange = (patch: UpdateDirectInput) => {
    if (!disabled) onChange(patch);
  };
  const updateMatcher = <K extends keyof DirectChannel["matcher"]>(
    key: K,
    value: DirectChannel["matcher"][K],
  ) => emitChange({ matcher: { ...channel.matcher, [key]: value } });

  return (
    <fieldset disabled={disabled} className="flex w-full min-w-0 flex-col border-0 p-0">
      <section className="direct-editor-system flex w-full flex-col gap-2.5 border-b border-border-subtle p-3.5 @min-[42rem]/app-page:gap-3 @min-[42rem]/app-page:px-[18px] @min-[42rem]/app-page:py-4">
        <SectionHeading
          title="Системные исключения"
          description="Встроенные правила без внешних списков"
        />
        <div className="flex flex-col gap-2.5 @min-[42rem]/app-page:flex-row @min-[42rem]/app-page:gap-3">
          <PresetToggle
            title="Частные сети"
            description="LAN, private IPv4/IPv6"
            checked={channel.directPresets.privateNetworks}
            onCheckedChange={(privateNetworks) =>
              emitChange({ directPresets: { ...channel.directPresets, privateNetworks } })
            }
          />
          <PresetToggle
            title="Локальные домены"
            description="localhost, .local, .lan, home.arpa"
            checked={channel.directPresets.localDomains}
            onCheckedChange={(localDomains) =>
              emitChange({ directPresets: { ...channel.directPresets, localDomains } })
            }
          />
        </div>
      </section>

      <section className="direct-editor-custom-heading flex w-full flex-col gap-[3px] px-3.5 pt-3.5 pb-2.5 @min-[42rem]/app-page:gap-1 @min-[42rem]/app-page:px-[18px] @min-[42rem]/app-page:pt-4 @min-[42rem]/app-page:pb-3">
        <SectionHeading
          title="Пользовательские правила"
          description="Все совпадения направляются в native DIRECT"
        />
      </section>

      <MatcherSection
        title="Предустановленные домены"
        description="Категории сервисов из общей библиотеки"
      >
        <PresetChips
          value={channel.matcher.presets}
          onChange={(presets) => updateMatcher("presets", presets)}
        />
      </MatcherSection>
      <MatcherSection title="Домены" description="Точные домены и суффиксы доменов">
        <DomainTags
          value={channel.matcher.domains}
          onChange={(domains) => updateMatcher("domains", domains)}
        />
      </MatcherSection>
      <MatcherSection
        title="Ключевые слова"
        description="Совпадение по части адреса (DOMAIN-KEYWORD)"
      >
        <KeywordTags
          value={channel.matcher.keywords}
          onChange={(keywords) => updateMatcher("keywords", keywords)}
        />
      </MatcherSection>
      <MatcherSection
        title="Списки правил"
        description="Внешние rule-providers, загружаемые напрямую"
      >
        <RuleProviderRows
          value={channel.matcher.ruleProviders}
          onChange={(ruleProviders) => updateMatcher("ruleProviders", ruleProviders)}
        />
      </MatcherSection>
      <MatcherSection title="GEOSITE" description="Категории доменов из geodata">
        <GeoSiteTags
          value={channel.matcher.geosite}
          onChange={(geosite) => updateMatcher("geosite", geosite)}
        />
      </MatcherSection>
      <MatcherSection title="GEOIP" description="Категории IP-адресов из geodata">
        <GeoIpTags
          value={channel.matcher.geoip}
          onChange={(geoip) => updateMatcher("geoip", geoip)}
        />
      </MatcherSection>
      <MatcherSection title="CIDR" description="IPv4 и IPv6 подсети в формате адрес/префикс">
        <CidrTags
          value={channel.matcher.cidrs}
          onChange={(cidrs) => updateMatcher("cidrs", cidrs)}
        />
      </MatcherSection>
    </fieldset>
  );
}

function SectionHeading({ title, description }: { title: string; description: string }) {
  return (
    <div className="flex flex-col gap-[3px]">
      <h3 className="text-label text-text-primary">{title}</h3>
      <p className="direct-section-caption text-fine text-text-tertiary">{description}</p>
    </div>
  );
}

function PresetToggle({
  title,
  description,
  checked,
  onCheckedChange,
}: {
  title: string;
  description: string;
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
}) {
  return (
    <div className="direct-preset-card flex min-w-0 flex-1 items-center justify-between gap-2.5 rounded-md border border-border-subtle bg-elevated px-3 py-2.5 @min-[42rem]/app-page:gap-4 @min-[42rem]/app-page:px-3.5 @min-[42rem]/app-page:py-3">
      <div className="flex min-w-0 flex-col gap-0.5 @min-[42rem]/app-page:gap-[3px]">
        <span className="text-sub font-medium text-text-primary">{title}</span>
        <span className="text-fine text-text-tertiary">{description}</span>
      </div>
      <Switch checked={checked} onCheckedChange={onCheckedChange} aria-label={title} />
    </div>
  );
}

function MatcherSection({
  title,
  description,
  children,
}: {
  title: string;
  description: string;
  children: ReactNode;
}) {
  return (
    <section className="direct-editor-section flex w-full flex-col gap-[9px] border-b border-border-subtle p-3.5 last:border-b-0 @min-[42rem]/app-page:gap-2.5 @min-[42rem]/app-page:px-[18px] @min-[42rem]/app-page:py-3.5">
      <SectionHeading title={title} description={description} />
      {children}
    </section>
  );
}
