import type {
  DomainCandidateReportItem,
  DomainCandidateReviewErrorReason,
  DomainCandidateReviewMutationResult,
  DomainIntelligenceReportSettings,
  DomainProbeCategory,
  DomainRuleScope,
} from "@submerge/shared";
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import {
  ArrowRight,
  ChevronDown,
  ChevronRight,
  CircleAlert,
  RefreshCw,
  Settings2,
} from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { PageHeader } from "@/components/PageHeader";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { useTRPC } from "@/lib/trpc";
import { cn } from "@/lib/utils";

type CandidateView = "candidates" | "exclusions";

const MODE_LABELS = {
  off: "Выключено",
  review: "Подтверждать вручную",
  automatic: "Автоматически",
} as const;

const MODE_DESCRIPTIONS = {
  off: "Submerge не наблюдает домены и не меняет список custom.",
  review:
    "Submerge предлагает правила и ждёт. В custom.txt ничего не попадает без вашего подтверждения.",
  automatic: "Подтверждённые правила публикуются сами в пределах дневного лимита.",
} as const;

export function DomainIntelligenceScreen() {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const [view, setView] = useState<CandidateView>("candidates");
  const [expanded, setExpanded] = useState<string | null>(null);
  const [firstInstallScope, setFirstInstallScope] = useState<DomainRuleScope | null>(null);

  const settingsQuery = useQuery(trpc.domainIntelligence.settings.queryOptions());
  const overviewQuery = useQuery(trpc.domainIntelligence.overview.queryOptions());
  const candidatesQuery = useInfiniteQuery(
    trpc.domainIntelligence.list.infiniteQueryOptions(
      { view: "candidates", limit: 50 },
      { getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined },
    ),
  );
  const exclusionsQuery = useInfiniteQuery(
    trpc.domainIntelligence.list.infiniteQueryOptions(
      { view: "exclusions", limit: 50 },
      { getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined },
    ),
  );

  const invalidate = () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: trpc.domainIntelligence.settings.queryKey() }),
      queryClient.invalidateQueries({ queryKey: trpc.domainIntelligence.overview.queryKey() }),
      queryClient.invalidateQueries({
        queryKey: trpc.domainIntelligence.list.infiniteQueryKey(),
      }),
    ]);
  const settingsMutation = useMutation(
    trpc.domainIntelligence.setSettings.mutationOptions({
      onSuccess: async (result) => {
        queryClient.setQueryData(trpc.domainIntelligence.settings.queryKey(), result.view);
        if (!result.applied) {
          toast.error("Настройки сохранены, но Mihomo не подтвердил активацию");
        }
        await invalidate();
      },
      onError: () => toast.error("Не удалось сохранить изменение"),
    }),
  );
  const reviewCallbacks = {
    onSuccess: async (result: DomainCandidateReviewMutationResult) => {
      if (!result.ok) toast.error(reviewErrorText(result.reason));
      await invalidate();
    },
    onError: () => toast.error("Не удалось сохранить изменение"),
  };
  const scopeMutation = useMutation(
    trpc.domainIntelligence.setScope.mutationOptions(reviewCallbacks),
  );
  const rejectionMutation = useMutation(
    trpc.domainIntelligence.setRejected.mutationOptions(reviewCallbacks),
  );
  const recheckMutation = useMutation(
    trpc.domainIntelligence.recheck.mutationOptions(reviewCallbacks),
  );

  const loading = settingsQuery.isLoading || overviewQuery.isLoading;
  const failed = settingsQuery.isError || overviewQuery.isError;
  const settingsView = settingsQuery.data;
  const overview = overviewQuery.data;
  const activeListQuery = view === "candidates" ? candidatesQuery : exclusionsQuery;
  const items = activeListQuery.data?.pages.flatMap((page) => page.items);
  const currentUtcDay = new Date(overview?.period.to ?? 0).toISOString().slice(0, 10);
  const seenToday =
    overview?.dailyAggregates.find((aggregate) => aggregate.day === currentUtcDay)
      ?.uniqueDomainCount ?? 0;

  function persistSettings(next: DomainIntelligenceReportSettings) {
    settingsMutation.mutate(next);
  }

  function selectMode(mode: "off" | "review") {
    if (!settingsView) return;
    if (mode === "review" && settingsView.configurationState !== "ready") return;
    persistSettings({
      ...settingsView.settings,
      enabled: mode === "review",
      automationMode: mode,
    });
  }

  function enableFirstInstall() {
    if (!settingsView || firstInstallScope === null) return;
    persistSettings({
      ...settingsView.settings,
      enabled: true,
      defaultRuleScope: firstInstallScope,
      automationMode: "review",
    });
  }

  return (
    <div className="responsive-page responsive-page--domain-intelligence page-content page-stack domain-intelligence-screen flex min-w-0 flex-col">
      <PageHeader
        title="Автоправила"
        subtitle="Домены, которым нужен VPN, попадают в список custom после проверки"
        actions={
          <Link
            to="/settings"
            className="domain-settings-link inline-flex h-8 items-center justify-center gap-2 rounded-md border border-border-default bg-elevated px-[14px] text-sub font-medium text-text-primary transition-colors hover:bg-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-border"
          >
            <Settings2 aria-hidden="true" size={15} />
            Настроить
          </Link>
        }
      />

      {loading ? (
        <LoadingState />
      ) : failed || !settingsView || !overview ? (
        <ErrorState
          onRetry={() => {
            void settingsQuery.refetch();
            void overviewQuery.refetch();
          }}
        />
      ) : (
        <>
          {settingsView.configurationState === "invalid" ? (
            <InlineWarning>
              Настройки механизма повреждены. Наблюдение и применение остановлены до исправления.
            </InlineWarning>
          ) : null}

          {settingsView.configurationState === "unconfigured" ? (
            <FirstInstallCard
              value={firstInstallScope}
              pending={settingsMutation.isPending}
              onChange={setFirstInstallScope}
              onEnable={enableFirstInstall}
            />
          ) : (
            <ModeCard
              settings={settingsView.settings}
              automaticAvailable={settingsView.automatic.available}
              seenToday={seenToday}
              health={overview.health.status}
              pending={settingsMutation.isPending}
              onSelect={selectMode}
            />
          )}

          <CandidatePanel
            view={view}
            candidatesCount={overview.bucketCounts.candidate}
            exclusionsCount={overview.bucketCounts.exclusion}
            items={items ?? []}
            loading={activeListQuery.isLoading}
            failed={activeListQuery.isError}
            hasMore={activeListQuery.hasNextPage}
            loadingMore={activeListQuery.isFetchingNextPage}
            expanded={expanded}
            publisherAvailable={settingsView.automatic.available}
            scopePending={scopeMutation.isPending}
            rejectionPending={rejectionMutation.isPending}
            recheckPending={recheckMutation.isPending}
            onView={setView}
            onExpand={(fqdn) => setExpanded((current) => (current === fqdn ? null : fqdn))}
            onScope={(fqdn, selectedScope) => scopeMutation.mutate({ fqdn, selectedScope })}
            onReject={(fqdn, rejected) => rejectionMutation.mutate({ fqdn, rejected })}
            onRecheck={(fqdn) => recheckMutation.mutate({ fqdn })}
            onRetry={() => void activeListQuery.refetch()}
            onLoadMore={() => void activeListQuery.fetchNextPage()}
          />

          <PublisherUnavailableCard />
        </>
      )}
    </div>
  );
}

function LoadingState() {
  return (
    <div aria-busy="true" className="flex flex-col gap-3.5">
      <Skeleton className="h-[104px] w-full rounded-lg" />
      <Skeleton className="h-[280px] w-full rounded-lg" />
      <Skeleton className="h-[180px] w-full rounded-lg" />
    </div>
  );
}

function ErrorState({ onRetry }: { onRetry: () => void }) {
  return (
    <section className="flex min-h-52 flex-col items-center justify-center gap-3 rounded-lg border border-border-subtle bg-surface p-8 text-center">
      <CircleAlert aria-hidden="true" size={22} className="text-timeout" />
      <div className="flex flex-col gap-1">
        <h2 className="text-cardtitle text-text-primary">Не удалось загрузить карту доменов</h2>
        <p className="text-sub text-text-secondary">Трафик продолжает идти как обычно.</p>
      </div>
      <Button variant="secondary" size="sm" onClick={onRetry}>
        Повторить
      </Button>
    </section>
  );
}

function InlineWarning({ children }: { children: string }) {
  return (
    <div className="flex items-start gap-2.5 rounded-lg border border-timeout/30 bg-timeout-bg px-4 py-3 text-sub text-text-secondary">
      <CircleAlert aria-hidden="true" size={17} className="mt-px shrink-0 text-timeout" />
      <span>{children}</span>
    </div>
  );
}

function FirstInstallCard({
  value,
  pending,
  onChange,
  onEnable,
}: {
  value: DomainRuleScope | null;
  pending: boolean;
  onChange: (value: DomainRuleScope) => void;
  onEnable: () => void;
}) {
  return (
    <section className="flex flex-col gap-4 rounded-lg border border-border-subtle bg-surface px-[18px] py-4">
      <div className="flex flex-col gap-1">
        <h2 className="text-cardtitle text-text-primary">Сначала выберите область правила</h2>
        <p className="text-sub text-text-secondary">
          Это начальный выбор для новых кандидатов. Его можно изменить у каждого домена.
        </p>
      </div>
      <ScopeButtons value={value} siteDisabled={false} onChange={onChange} />
      <div className="flex flex-wrap items-center justify-between gap-3">
        <span className="text-fine text-text-tertiary">
          Общие хостинги и CDN всё равно останутся на точном адресе.
        </span>
        <Button disabled={value === null || pending} onClick={onEnable}>
          Включить наблюдение
        </Button>
      </div>
    </section>
  );
}

function ModeCard({
  settings,
  automaticAvailable,
  seenToday,
  health,
  pending,
  onSelect,
}: {
  settings: DomainIntelligenceReportSettings;
  automaticAvailable: boolean;
  seenToday: number;
  health: "inactive" | "accumulating" | "healthy" | "degraded";
  pending: boolean;
  onSelect: (mode: "off" | "review") => void;
}) {
  const mode = settings.automationMode;
  const statusLabel = (() => {
    if (!settings.enabled) return "Наблюдение выключено";
    if (health === "degraded") return "Наблюдение неполное";
    if (health === "inactive") return "Активация не подтверждена";
    if (health === "accumulating") return "Наблюдение набирает данные";
    return "Наблюдение активно";
  })();
  return (
    <section className="domain-mode-card flex min-w-0 items-center justify-between gap-6 rounded-lg border border-border-subtle bg-surface px-[18px] py-4">
      <div className="flex min-w-0 flex-1 flex-col gap-2.5">
        <fieldset
          aria-label="Режим автоправил"
          className="domain-mode-segmented flex w-fit max-w-full flex-wrap gap-[3px] rounded-md border border-border-subtle bg-canvas p-[3px]"
        >
          {(["off", "review", "automatic"] as const).map((option) => {
            const disabled = pending || (option === "automatic" && !automaticAvailable);
            return (
              <button
                key={option}
                type="button"
                disabled={disabled}
                aria-current={mode === option ? "true" : undefined}
                title={
                  option === "automatic" && !automaticAvailable
                    ? "Publisher не настроен на сервере"
                    : undefined
                }
                onClick={() => option !== "automatic" && onSelect(option)}
                className={cn(
                  "rounded-sm px-[13px] py-[7px] text-sub font-medium transition-colors disabled:text-text-disabled",
                  mode === option
                    ? "bg-accent text-accent-fg disabled:bg-accent disabled:text-accent-fg"
                    : "text-text-secondary hover:text-text-primary",
                )}
              >
                {MODE_LABELS[option]}
              </button>
            );
          })}
        </fieldset>
        <p className="text-meta text-text-tertiary">{MODE_DESCRIPTIONS[mode]}</p>
        {!automaticAvailable ? (
          <p className="text-fine text-text-tertiary">
            Автоматический режим недоступен: нет подтверждённой Git-capability.
          </p>
        ) : null}
      </div>
      <div className="domain-mode-status flex shrink-0 flex-col items-end gap-1.5 text-right">
        <span className="inline-flex items-center gap-2 text-meta font-medium text-text-secondary">
          <span
            aria-hidden="true"
            className={cn(
              "h-[7px] w-[7px] rounded-full",
              health === "degraded" || (settings.enabled && health === "inactive")
                ? "bg-slow"
                : settings.enabled
                  ? "bg-online"
                  : "bg-idle",
            )}
          />
          {statusLabel}
        </span>
        <span className="font-mono text-fine text-text-tertiary">
          {seenToday} доменов сегодня (UTC)
        </span>
      </div>
    </section>
  );
}

function CandidatePanel({
  view,
  candidatesCount,
  exclusionsCount,
  items,
  loading,
  failed,
  hasMore,
  loadingMore,
  expanded,
  publisherAvailable,
  scopePending,
  rejectionPending,
  recheckPending,
  onView,
  onExpand,
  onScope,
  onReject,
  onRecheck,
  onRetry,
  onLoadMore,
}: {
  view: CandidateView;
  candidatesCount: number;
  exclusionsCount: number;
  items: readonly DomainCandidateReportItem[];
  loading: boolean;
  failed: boolean;
  hasMore: boolean;
  loadingMore: boolean;
  expanded: string | null;
  publisherAvailable: boolean;
  scopePending: boolean;
  rejectionPending: boolean;
  recheckPending: boolean;
  onView: (view: CandidateView) => void;
  onExpand: (fqdn: string) => void;
  onScope: (fqdn: string, scope: DomainRuleScope) => void;
  onReject: (fqdn: string, rejected: boolean) => void;
  onRecheck: (fqdn: string) => void;
  onRetry: () => void;
  onLoadMore: () => void;
}) {
  return (
    <section className="overflow-hidden rounded-lg border border-border-subtle bg-surface">
      <header className="flex min-h-12 items-center justify-between gap-3 border-b border-border-subtle bg-elevated px-[18px] py-2.5">
        <button
          type="button"
          aria-current={view === "candidates" ? "true" : undefined}
          onClick={() => onView("candidates")}
          className="inline-flex items-center gap-2 text-label font-semibold text-text-primary"
        >
          Ждут подтверждения
          <span className="rounded-full bg-accent px-2 py-0.5 font-mono text-fine font-bold text-accent-fg">
            {candidatesCount}
          </span>
        </button>
        <button
          type="button"
          aria-current={view === "exclusions" ? "true" : undefined}
          onClick={() => onView("exclusions")}
          className="inline-flex min-h-8 items-center gap-1.5 text-meta font-medium text-text-tertiary hover:text-text-secondary"
        >
          Исключения · {exclusionsCount}
          <ChevronRight aria-hidden="true" size={14} />
        </button>
      </header>

      {loading ? (
        <div className="flex flex-col gap-2 p-4">
          <Skeleton className="h-[62px] w-full rounded-md" />
          <Skeleton className="h-[62px] w-full rounded-md" />
        </div>
      ) : failed ? (
        <div className="flex min-h-40 flex-col items-center justify-center gap-3 px-6 py-8 text-center">
          <div className="flex flex-col gap-1.5">
            <h3 className="text-cardtitle text-text-primary">
              Не удалось загрузить список доменов
            </h3>
            <p className="text-sub text-text-secondary">Показ предыдущих данных остановлен.</p>
          </div>
          <Button variant="secondary" size="sm" onClick={onRetry}>
            Повторить
          </Button>
        </div>
      ) : items.length === 0 ? (
        <div className="flex min-h-40 flex-col items-center justify-center gap-1.5 px-6 py-8 text-center">
          <h3 className="text-cardtitle text-text-primary">
            {view === "candidates" ? "Нечего подтверждать" : "Исключений нет"}
          </h3>
          <p className="max-w-xl text-sub text-text-secondary">
            {view === "candidates"
              ? "Submerge продолжает наблюдать и проверять домены асинхронно."
              : "Отклонённые и заблокированные кандидаты появятся здесь с причиной."}
          </p>
        </div>
      ) : (
        <>
          <div className="divide-y divide-border-subtle">
            {items.map((item) => (
              <CandidateRow
                key={item.fqdn}
                item={item}
                expanded={expanded === item.fqdn}
                publisherAvailable={publisherAvailable}
                scopePending={scopePending}
                rejectionPending={rejectionPending}
                recheckPending={recheckPending}
                onExpand={() => onExpand(item.fqdn)}
                onScope={(scope) => onScope(item.fqdn, scope)}
                onReject={(rejected) => onReject(item.fqdn, rejected)}
                onRecheck={() => onRecheck(item.fqdn)}
              />
            ))}
          </div>
          {hasMore ? (
            <div className="flex justify-center border-t border-border-subtle p-3">
              <Button variant="secondary" size="sm" disabled={loadingMore} onClick={onLoadMore}>
                {loadingMore ? "Загрузка…" : "Загрузить ещё"}
              </Button>
            </div>
          ) : null}
        </>
      )}
    </section>
  );
}

function CandidateRow({
  item,
  expanded,
  publisherAvailable,
  scopePending,
  rejectionPending,
  recheckPending,
  onExpand,
  onScope,
  onReject,
  onRecheck,
}: {
  item: DomainCandidateReportItem;
  expanded: boolean;
  publisherAvailable: boolean;
  scopePending: boolean;
  rejectionPending: boolean;
  recheckPending: boolean;
  onExpand: () => void;
  onScope: (scope: DomainRuleScope) => void;
  onReject: (rejected: boolean) => void;
  onRecheck: () => void;
}) {
  const exactOnly = item.eligibleScopes.length === 1 && item.eligibleScopes[0] === "exact";
  const observedDomain = observedDomainParts(item.fqdn, item.siteGroup);
  const scopeLabel =
    item.selectedScope === null
      ? null
      : item.selectedScope === "site"
        ? "сайт целиком"
        : "только точный адрес";
  return (
    <article className="min-w-0">
      <div className="domain-candidate-row flex min-w-0 items-center gap-3.5 px-[18px] py-[13px]">
        <div className="min-w-0 flex-1">
          <div className="domain-candidate-rule flex min-w-0 items-center gap-2">
            <span
              title={item.fqdn}
              className="domain-observed-name min-w-0 font-mono text-sub text-text-secondary"
            >
              {observedDomain.prefix ? (
                <span className="domain-observed-prefix">{observedDomain.prefix}</span>
              ) : null}
              <span className="domain-observed-suffix">{observedDomain.suffix}</span>
            </span>
            {item.proposedRule ? (
              <>
                <ArrowRight aria-hidden="true" size={13} className="shrink-0 text-text-disabled" />
                <code className="domain-generated-rule font-mono text-sub font-semibold text-text-primary">
                  {item.proposedRule}
                </code>
              </>
            ) : null}
            {scopeLabel ? (
              <span className="shrink-0 rounded-full bg-hover px-[7px] py-0.5 text-micro font-medium text-text-secondary">
                {scopeLabel}
              </span>
            ) : null}
          </div>
          <p className="mt-1 text-fine text-text-tertiary">{candidateSummary(item)}</p>
        </div>
        <div className="domain-candidate-actions flex shrink-0 items-center gap-2">
          {item.bucket === "candidate" ? (
            <>
              <Button
                variant="ghost"
                size="sm"
                disabled={rejectionPending}
                aria-label={`Не добавлять ${item.fqdn}`}
                onClick={() => onReject(true)}
              >
                Не добавлять
              </Button>
              <Button
                size="sm"
                disabled={!publisherAvailable || item.status !== "confirmed"}
                title={!publisherAvailable ? "Apply не настроен на сервере" : undefined}
              >
                Добавить
              </Button>
            </>
          ) : (
            <ExclusionAction
              item={item}
              pending={item.reviewState === "rejected" ? rejectionPending : recheckPending}
              onRestore={() => onReject(false)}
              onRecheck={onRecheck}
            />
          )}
          <button
            type="button"
            aria-label={`Подробнее о ${item.fqdn}`}
            aria-expanded={expanded}
            onClick={onExpand}
            className="flex h-8 w-8 items-center justify-center rounded-md text-text-disabled hover:bg-hover hover:text-text-secondary"
          >
            <ChevronDown
              aria-hidden="true"
              size={16}
              className={cn("transition-transform", expanded && "rotate-180")}
            />
          </button>
        </div>
      </div>
      {expanded ? (
        <div className="domain-candidate-detail grid gap-4 border-t border-border-subtle bg-canvas/40 px-[18px] py-4">
          <EvidenceBlock item={item} />
          {item.bucket === "candidate" ? (
            <div className="flex min-w-0 flex-col gap-2.5">
              <span className="text-caption text-text-tertiary">ОБЛАСТЬ</span>
              <ScopeButtons
                value={item.selectedScope}
                siteDisabled={!item.eligibleScopes.some((scope) => scope === "site")}
                pending={scopePending}
                onChange={onScope}
              />
              {exactOnly ? (
                <p className="text-fine text-text-tertiary">{exactScopeExplanation(item)}</p>
              ) : (
                <p className="text-fine text-text-tertiary">
                  Сайт целиком покрывает {item.siteGroup} и его поддомены; точный адрес — только
                  наблюдавшийся FQDN.
                </p>
              )}
            </div>
          ) : (
            <p className="text-sub text-text-secondary">{exclusionText(item)}</p>
          )}
        </div>
      ) : null}
    </article>
  );
}

function ExclusionAction({
  item,
  pending,
  onRestore,
  onRecheck,
}: {
  item: DomainCandidateReportItem;
  pending: boolean;
  onRestore: () => void;
  onRecheck: () => void;
}) {
  if (item.reviewState === "rejected") {
    return (
      <Button size="sm" variant="secondary" onClick={onRestore}>
        Вернуть
      </Button>
    );
  }
  if (item.exclusionReason === "already-covered") {
    return (
      <Link
        to="/routing"
        className="domain-candidate-action inline-flex min-h-8 items-center justify-center rounded-md border border-border-default bg-elevated px-[14px] text-sub font-medium text-text-primary hover:bg-hover"
      >
        Показать правило
      </Link>
    );
  }
  if (
    item.exclusionReason === "telemetry-pattern" ||
    item.exclusionReason === "never-add-domain" ||
    item.exclusionReason === "never-add-suffix" ||
    item.exclusionReason === "excluded-tld"
  ) {
    return (
      <Link
        to="/settings"
        className="domain-candidate-action inline-flex min-h-8 items-center justify-center rounded-md border border-border-default bg-elevated px-[14px] text-sub font-medium text-text-primary hover:bg-hover"
      >
        Изменить фильтр
      </Link>
    );
  }
  return (
    <Button size="sm" variant="secondary" disabled={pending} onClick={onRecheck}>
      <RefreshCw aria-hidden="true" size={14} />
      Проверить снова
    </Button>
  );
}

function ScopeButtons({
  value,
  siteDisabled,
  pending = false,
  onChange,
}: {
  value: DomainRuleScope | null;
  siteDisabled: boolean;
  pending?: boolean;
  onChange: (scope: DomainRuleScope) => void;
}) {
  return (
    <fieldset
      aria-label="Область правила"
      className="flex w-fit max-w-full gap-[3px] rounded-md border border-border-subtle bg-canvas p-[3px]"
    >
      <button
        type="button"
        disabled={pending || siteDisabled}
        aria-current={value === "site" ? "true" : undefined}
        onClick={() => onChange("site")}
        className={scopeButtonClass(value === "site")}
      >
        Сайт целиком
      </button>
      <button
        type="button"
        disabled={pending}
        aria-current={value === "exact" ? "true" : undefined}
        onClick={() => onChange("exact")}
        className={scopeButtonClass(value === "exact")}
      >
        Только точный адрес
      </button>
    </fieldset>
  );
}

function scopeButtonClass(active: boolean) {
  return cn(
    "rounded-sm px-3 py-[7px] text-sub font-medium transition-colors disabled:text-text-disabled",
    active ? "bg-accent text-accent-fg" : "text-text-secondary hover:text-text-primary",
  );
}

function EvidenceBlock({ item }: { item: DomainCandidateReportItem }) {
  if (item.evidenceIntegrityIssue !== null) {
    return (
      <div className="rounded-md border border-timeout/30 bg-timeout-bg px-3 py-2.5 text-fine text-text-secondary">
        Доказательства недоступны: требуется повторная проверка кандидата.
      </div>
    );
  }
  const direct = item.latestAttempts.direct;
  const proxy = item.latestAttempts.proxy;
  const directView = probeAttemptView(direct);
  const proxyView = probeAttemptView(proxy);
  return (
    <div className="domain-evidence-grid grid min-w-0 gap-3">
      <EvidenceCell label="DIRECT" value={directView.value} tone={directView.tone} />
      <EvidenceCell label="PROXY" value={proxyView.value} tone={proxyView.tone} />
      <EvidenceCell
        label="ПОКРЫТИЕ"
        value={
          item.status === "confirmed" &&
          item.evidenceAvailable &&
          item.decision?.status === "confirmed"
            ? "проверено, активными правилами не покрыт"
            : "повторно проверяется перед применением"
        }
      />
    </div>
  );
}

function EvidenceCell({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone?: "danger" | "success" | undefined;
}) {
  return (
    <div className="flex min-w-0 flex-col gap-1 rounded-md border border-border-subtle bg-surface px-3 py-2.5">
      <span className="text-caption text-text-tertiary">{label}</span>
      <span
        className={cn(
          "text-fine",
          tone === "danger"
            ? "text-timeout"
            : tone === "success"
              ? "text-online"
              : "text-text-secondary",
        )}
      >
        {value}
      </span>
    </div>
  );
}

function PublisherUnavailableCard() {
  return (
    <section className="flex min-w-0 items-center justify-between gap-4 rounded-lg border border-border-subtle bg-surface px-[18px] py-4">
      <div className="flex min-w-0 flex-col gap-1">
        <h2 className="text-label font-semibold text-text-primary">Список custom</h2>
        <p className="text-sub text-text-secondary">
          Publisher ещё не настроен на сервере. Отчёт и проверки работают, применение заблокировано.
        </p>
      </div>
      <span className="shrink-0 rounded-full bg-hover px-2.5 py-1 text-fine font-medium text-text-tertiary">
        report-only
      </span>
    </section>
  );
}

function candidateSummary(item: DomainCandidateReportItem): string {
  if (item.evidenceIntegrityIssue !== null) {
    return "Доказательства недоступны · требуется повторная проверка";
  }
  if (item.status === "confirmed") {
    return `DIRECT не отвечает · через VPN работает · ${item.connectionCount} обращений за период`;
  }
  if (item.status === "pending" || item.status === "queued") {
    return `Накапливаются проверки · ${item.connectionCount} обращений за период`;
  }
  return exclusionText(item);
}

function probeAttemptView(attempt: DomainCandidateReportItem["latestAttempts"]["direct"]): {
  value: string;
  tone?: "danger" | "success";
} {
  if (!attempt) return { value: "результат ещё не записан" };
  const value =
    attempt.httpStatus !== null
      ? `HTTP ${attempt.httpStatus} · ${attempt.totalDurationMs} мс`
      : `${probeCategoryText(attempt.category)} · ${attempt.totalDurationMs} мс`;
  return { value, tone: attempt.transportSuccess ? "success" : "danger" };
}

function reviewErrorText(reason: DomainCandidateReviewErrorReason): string {
  const labels: Record<DomainCandidateReviewErrorReason, string> = {
    "candidate-not-found": "Кандидат больше не существует",
    "candidate-rejected": "Сначала верните кандидата из исключений",
    "candidate-excluded": "Кандидат исключён текущей политикой",
    "policy-unavailable": "Политика фильтрации сейчас недоступна",
    "scope-unavailable": "Эта область больше недоступна",
    "validation-in-progress": "Проверка уже выполняется",
  };
  return labels[reason];
}

function exactScopeExplanation(item: DomainCandidateReportItem): string {
  if (item.siteUnavailableReason === "public-suffix") {
    return `${item.siteGroup} — публичный суффикс: расширять правило до него нельзя. Кандидат остаётся допустимым только на точном адресе.`;
  }
  if (item.siteUnavailableReason === "non-widenable-suffix") {
    return `Для адреса найден суффикс из списка «Не расширять»: +.${item.siteGroup} могло бы увести в VPN чужие сайты. Кандидат остаётся допустимым, но правило — только на точный адрес.`;
  }
  return "Расширение недоступно по текущей политике; правило остаётся на точном адресе.";
}

function observedDomainParts(fqdn: string, siteGroup: string): { prefix: string; suffix: string } {
  const semanticSuffix = fqdn !== siteGroup && fqdn.endsWith(`.${siteGroup}`) ? siteGroup : fqdn;
  const suffix = boundedDomainSuffix(semanticSuffix);
  return {
    prefix: fqdn.slice(0, fqdn.length - suffix.length),
    suffix,
  };
}

const observedDomainSuffixLimit = 28;

function boundedDomainSuffix(domain: string): string {
  if (domain.length <= observedDomainSuffixLimit) return domain;
  const labels = domain.split(".");
  let suffix = labels.pop() ?? domain.slice(-observedDomainSuffixLimit);
  while (labels.length > 0) {
    const label = labels.at(-1);
    if (!label || label.length + suffix.length + 1 > observedDomainSuffixLimit) break;
    suffix = `${label}.${suffix}`;
    labels.pop();
  }
  return suffix.length <= observedDomainSuffixLimit
    ? suffix
    : suffix.slice(-observedDomainSuffixLimit);
}

function exclusionText(item: DomainCandidateReportItem): string {
  const reason = item.exclusionReason;
  if (reason === "user-rejected") return "Отклонён вами";
  if (reason === "proxy-unstable") return "Через VPN тоже отвечает нестабильно";
  if (reason === "already-covered") return "Уже покрыт активным правилом или списком";
  if (reason === "telemetry-pattern") return "Совпал с шаблоном телеметрии";
  if (reason === "never-add-domain" || reason === "never-add-suffix") {
    return "Совпал со списком «Не добавлять»";
  }
  return "Предложение заблокировано текущей политикой";
}

function probeCategoryText(category: DomainProbeCategory): string {
  const labels: Record<string, string> = {
    http_response: "HTTP-ответ",
    dns_failure: "DNS не отвечает",
    connect_timeout: "таймаут соединения",
    tls_timeout: "таймаут TLS",
    tls_handshake_reset: "TLS reset",
    connection_reset_before_http: "соединение сброшено",
    proxy_auth_failure: "ошибка доступа к proxy",
    route_proof_failure: "маршрут не подтверждён",
    infrastructure_error: "ошибка инфраструктуры",
  };
  return labels[String(category)] ?? "сетевая ошибка";
}
