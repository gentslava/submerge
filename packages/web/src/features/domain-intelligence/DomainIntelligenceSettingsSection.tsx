import type {
  DomainIntelligenceReportSettings,
  DomainIntelligenceSettingsMutationResult,
  DomainRuleScope,
} from "@submerge/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronRight, CircleAlert, Save } from "lucide-react";
import { type ReactNode, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { LabeledControlRow as Row } from "@/components/ui/labeled-control-row";
import { ResponsiveDialog } from "@/components/ui/responsive-dialog";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { useTRPC } from "@/lib/trpc";
import { cn } from "@/lib/utils";

type EditorKind = "never-add" | "do-not-widen" | null;

export function DomainIntelligenceSettingsSection() {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const settingsQuery = useQuery(trpc.domainIntelligence.settings.queryOptions());
  const [editor, setEditor] = useState<EditorKind>(null);
  const settingsView = settingsQuery.data;

  const mutation = useMutation(
    trpc.domainIntelligence.setSettings.mutationOptions({
      onSuccess: async (result: DomainIntelligenceSettingsMutationResult) => {
        queryClient.setQueryData(trpc.domainIntelligence.settings.queryKey(), result.view);
        if (result.applied) {
          setEditor(null);
          toast.success("Настройки автоправил сохранены");
        } else {
          toast.error("Настройки сохранены, но Mihomo не подтвердил активацию");
        }
        await Promise.all([
          queryClient.invalidateQueries({
            queryKey: trpc.domainIntelligence.settings.queryKey(),
          }),
          queryClient.invalidateQueries({
            queryKey: trpc.domainIntelligence.overview.queryKey(),
          }),
          queryClient.invalidateQueries({
            queryKey: trpc.domainIntelligence.list.infiniteQueryKey(),
          }),
        ]);
      },
      onError: () => toast.error("Не удалось сохранить настройки автоправил"),
    }),
  );

  function persist(patch: Partial<DomainIntelligenceReportSettings>) {
    if (!settingsView) return;
    mutation.mutate({ ...settingsView.settings, ...patch });
  }

  if (settingsQuery.isLoading) {
    return <Skeleton className="h-[420px] w-full rounded-lg" />;
  }
  if (settingsQuery.isError || !settingsView) {
    return (
      <section className="flex flex-col gap-3.5">
        <SectionHeading />
        <div className="flex items-center justify-between gap-3 rounded-lg border border-border-subtle bg-surface px-[18px] py-4">
          <span className="inline-flex items-center gap-2 text-sub text-text-secondary">
            <CircleAlert aria-hidden="true" size={16} className="text-timeout" />
            Не удалось загрузить настройки автоправил
          </span>
          <Button variant="secondary" size="sm" onClick={() => settingsQuery.refetch()}>
            Повторить
          </Button>
        </div>
      </section>
    );
  }

  const settings = settingsView.settings;
  const disabled = mutation.isPending;
  const neverAddCount =
    settings.neverAddDomains.length +
    settings.neverAddSuffixes.length +
    settings.excludedTlds.length +
    settings.telemetryPatterns.length;

  return (
    <section className="flex flex-col gap-3.5">
      <SectionHeading />
      <div className="flex flex-col overflow-hidden rounded-lg border border-border-subtle bg-surface">
        <Row label="Область правила" sub="Общие хостинги и CDN не расширяются в любом случае">
          <ScopePicker
            value={settings.defaultRuleScope}
            disabled={disabled}
            onChange={(defaultRuleScope) => persist({ defaultRuleScope })}
          />
        </Row>
        <Row label="Правил в сутки" sub="Потолок для автоматического режима">
          <BoundedNumber
            label="Правил в сутки"
            value={settings.maximumAutomaticRulesPerDay}
            min={1}
            max={3}
            disabled={disabled}
            onCommit={(maximumAutomaticRulesPerDay) => persist({ maximumAutomaticRulesPerDay })}
          />
        </Row>
        <Row label="Неудачных попыток напрямую" sub="Сколько DIRECT-сбоев требуется для кандидата">
          <BoundedNumber
            label="Неудачных попыток напрямую"
            value={settings.directAttemptsRequired}
            min={3}
            max={24}
            disabled={disabled}
            onCommit={(directAttemptsRequired) => persist({ directAttemptsRequired })}
          />
        </Row>
        <Row label="Интервал между попытками, мин" sub="Защита от разового сетевого сбоя">
          <BoundedNumber
            label="Интервал между попытками, мин"
            value={settings.minimumAttemptSpacingMinutes}
            min={120}
            max={1_440}
            disabled={disabled}
            onCommit={(minimumAttemptSpacingMinutes) => persist({ minimumAttemptSpacingMinutes })}
          />
        </Row>
        <Row label="Не добавлять" sub="Домены не становятся кандидатами и не проверяются">
          <EditorButton
            label={`Не добавлять · ${neverAddCount}`}
            disabled={disabled}
            onClick={() => setEditor("never-add")}
          />
        </Row>
        <Row label="Не расширять" sub="Кандидаты допустимы, но только как точные адреса">
          <EditorButton
            label={`Не расширять · ${settings.nonWidenableSuffixes.length}`}
            disabled={disabled}
            onClick={() => setEditor("do-not-widen")}
          />
        </Row>
        <Row label="Хранить наблюдения, дней" sub="История добавленных правил сохраняется">
          <span className="font-mono text-sub text-text-secondary">{settings.retentionDays}</span>
        </Row>
      </div>

      {editor === "never-add" ? (
        <NeverAddEditor
          settings={settings}
          pending={mutation.isPending}
          onClose={() => setEditor(null)}
          onSave={(patch) => persist(patch)}
        />
      ) : null}
      {editor === "do-not-widen" ? (
        <DoNotWidenEditor
          values={settings.nonWidenableSuffixes}
          pending={mutation.isPending}
          onClose={() => setEditor(null)}
          onSave={(nonWidenableSuffixes) => persist({ nonWidenableSuffixes })}
        />
      ) : null}

      {settingsView.configurationState === "invalid" ? (
        <p className="text-fine text-timeout">
          Настройки повреждены: механизм остановлен, пока конфигурация не будет исправлена.
        </p>
      ) : null}
    </section>
  );
}

function SectionHeading() {
  return (
    <div className="flex flex-col gap-1">
      <h2 className="text-cardtitle text-text-primary">Автоправила</h2>
      <p className="settings-section-description hidden text-sub text-text-secondary">
        Область правил, пороги, лимиты и независимые фильтры механизма.
      </p>
    </div>
  );
}

function ScopePicker({
  value,
  disabled,
  onChange,
}: {
  value: DomainRuleScope | null;
  disabled: boolean;
  onChange: (value: DomainRuleScope) => void;
}) {
  return (
    <fieldset
      aria-label="Область правила"
      className="flex gap-[3px] rounded-md border border-border-subtle bg-canvas p-[3px]"
    >
      {(
        [
          ["site", "Сайт целиком"],
          ["exact", "Только адрес"],
        ] as const
      ).map(([scope, label]) => (
        <button
          key={scope}
          type="button"
          disabled={disabled}
          aria-current={value === scope ? "true" : undefined}
          onClick={() => onChange(scope)}
          className={cn(
            "rounded-sm px-3 py-[7px] text-sub font-medium disabled:text-text-disabled",
            value === scope ? "bg-accent on-accent-fg" : "text-text-secondary",
          )}
        >
          {label}
        </button>
      ))}
    </fieldset>
  );
}

function BoundedNumber({
  label,
  value,
  min,
  max,
  disabled,
  onCommit,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  disabled: boolean;
  onCommit: (value: number) => void;
}) {
  return (
    <Input
      key={value}
      aria-label={label}
      type="number"
      min={min}
      max={max}
      disabled={disabled}
      defaultValue={value}
      className="w-24 font-mono text-sub"
      onBlur={(event) => {
        const next = Number(event.currentTarget.value);
        if (Number.isInteger(next) && next >= min && next <= max && next !== value) {
          onCommit(next);
        }
      }}
    />
  );
}

function EditorButton({
  label,
  disabled,
  onClick,
}: {
  label: string;
  disabled: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className="inline-flex min-h-9 items-center gap-1.5 rounded-md px-2 text-sub font-medium text-accent-text hover:bg-accent-bg disabled:text-text-disabled"
    >
      {label}
      <ChevronRight aria-hidden="true" size={14} />
    </button>
  );
}

function NeverAddEditor({
  settings,
  pending,
  onClose,
  onSave,
}: {
  settings: DomainIntelligenceReportSettings;
  pending: boolean;
  onClose: () => void;
  onSave: (
    patch: Pick<
      DomainIntelligenceReportSettings,
      "excludedTlds" | "neverAddDomains" | "neverAddSuffixes" | "telemetryPatterns"
    >,
  ) => void;
}) {
  const [domains, setDomains] = useState(joinLines(settings.neverAddDomains));
  const [suffixes, setSuffixes] = useState(joinLines(settings.neverAddSuffixes));
  const [tlds, setTlds] = useState(joinLines(settings.excludedTlds));
  const [patterns, setPatterns] = useState(joinLines(settings.telemetryPatterns));
  return (
    <FilterEditor
      title="Не добавлять"
      onClose={onClose}
      footer={
        <EditorSave
          label="Сохранить «Не добавлять»"
          pending={pending}
          onClick={() =>
            onSave({
              neverAddDomains: splitLines(domains),
              neverAddSuffixes: splitLines(suffixes),
              excludedTlds: splitLines(tlds),
              telemetryPatterns: splitLines(patterns),
            })
          }
        />
      }
    >
      <EditorField label="Домены, которые не добавлять" value={domains} onChange={setDomains} />
      <EditorField label="Суффиксы, которые не добавлять" value={suffixes} onChange={setSuffixes} />
      <EditorField label="Доменные зоны, которые не добавлять" value={tlds} onChange={setTlds} />
      <EditorField label="Шаблоны телеметрии" value={patterns} onChange={setPatterns} />
    </FilterEditor>
  );
}

function DoNotWidenEditor({
  values,
  pending,
  onClose,
  onSave,
}: {
  values: readonly string[];
  pending: boolean;
  onClose: () => void;
  onSave: (values: string[]) => void;
}) {
  const [suffixes, setSuffixes] = useState(joinLines(values));
  return (
    <FilterEditor
      title="Не расширять"
      onClose={onClose}
      footer={
        <EditorSave
          label="Сохранить «Не расширять»"
          pending={pending}
          onClick={() => onSave(splitLines(suffixes))}
        />
      }
    >
      <p className="text-fine text-text-tertiary">
        Эти домены остаются кандидатами, но site-scope для них недоступен. Публичные суффиксы
        добавлять не нужно — они защищены всегда.
      </p>
      <EditorField label="Суффиксы, которые не расширять" value={suffixes} onChange={setSuffixes} />
    </FilterEditor>
  );
}

function FilterEditor({
  title,
  onClose,
  footer,
  children,
}: {
  title: string;
  onClose: () => void;
  footer: ReactNode;
  children: ReactNode;
}) {
  return (
    <ResponsiveDialog
      title={title}
      closeLabel={`Закрыть редактор «${title}»`}
      size="compact"
      onClose={onClose}
      footer={footer}
    >
      <div className="domain-filter-editor-grid grid gap-3">{children}</div>
    </ResponsiveDialog>
  );
}

function EditorField({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
}) {
  const id = `domain-filter-${label.replace(/[^a-zа-я0-9]+/giu, "-").toLowerCase()}`;
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <label htmlFor={id} className="text-meta font-medium text-text-secondary">
        {label}
      </label>
      <Textarea
        id={id}
        aria-label={label}
        value={value}
        onChange={(event) => onChange(event.currentTarget.value)}
        spellCheck={false}
        className="min-h-28 font-mono text-fine"
      />
    </div>
  );
}

function EditorSave({
  label,
  pending,
  onClick,
}: {
  label: string;
  pending: boolean;
  onClick: () => void;
}) {
  return (
    <div className="flex items-end justify-end">
      <Button disabled={pending} onClick={onClick}>
        <Save aria-hidden="true" size={15} />
        {label}
      </Button>
    </div>
  );
}

function joinLines(values: readonly string[]): string {
  return [...values].sort().join("\n");
}

function splitLines(raw: string): string[] {
  return [
    ...new Set(
      raw
        .split(/\r?\n/u)
        .map((value) => value.trim().toLowerCase())
        .filter(Boolean),
    ),
  ].sort();
}
