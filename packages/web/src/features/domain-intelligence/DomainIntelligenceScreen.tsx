import {
  type DomainCandidateReportItem,
  type DomainCandidateReviewErrorReason,
  type DomainCandidateReviewMutationResult,
  type DomainIntelligenceApplyReadiness,
  type DomainIntelligenceReportSettings,
  type DomainIntelligenceSettingsView,
  type DomainProbeCategory,
  type DomainReportExclusionReason,
  type DomainRuleScope,
  domainIntelligenceDeploymentCapabilitySchema,
} from "@submerge/shared";
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import {
  ArrowRight,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  CircleAlert,
  Eye,
  Plus,
  RefreshCw,
  Settings2,
  Shield,
} from "lucide-react";
import { type ReactNode, useRef, useState } from "react";
import { toast } from "sonner";
import { PageHeader } from "@/components/PageHeader";
import { Button, buttonVariants } from "@/components/ui/button";
import { ResponsiveDialog } from "@/components/ui/responsive-dialog";
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
  automatic: "Подтверждённые правила добавляются в custom.txt в пределах дневного лимита.",
} as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function resolveApplyReadiness(settingsView: unknown): DomainIntelligenceApplyReadiness | null {
  if (!isRecord(settingsView)) return null;
  const parsed = domainIntelligenceDeploymentCapabilitySchema.safeParse(settingsView.deployment);
  return parsed.success ? parsed.data.apply : null;
}

function candidateApplyUnavailableMessage(
  settingsView: DomainIntelligenceSettingsView,
  deployment: DomainIntelligenceApplyReadiness,
): string | null {
  if (!deployment.available) return applyActionUnavailableMessage(deployment);
  if (settingsView.configurationState !== "ready") {
    return "Сначала выберите область правила и включите наблюдение";
  }
  if (!settingsView.settings.enabled || settingsView.settings.automationMode !== "review") {
    return "Добавление доступно в режиме «Подтверждать вручную»";
  }
  return null;
}

function createManualApplyOperationId(): string {
  const randomUuid = globalThis.crypto?.randomUUID;
  if (typeof randomUuid === "function") {
    return `manual-add-${randomUuid.call(globalThis.crypto)}`;
  }
  return `manual-add-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 14)}`;
}

export function DomainIntelligenceScreen() {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const [exclusionsOpen, setExclusionsOpen] = useState(false);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [firstInstallScope, setFirstInstallScope] = useState<DomainRuleScope | null>(null);
  const [applyingFqdns, setApplyingFqdns] = useState<ReadonlySet<string>>(() => new Set());

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
  const candidateApplyMutation = useMutation(
    trpc.domainIntelligence.applyCandidate.mutationOptions({
      onSuccess: async (result) => {
        if (result.phase === "completed") {
          toast.success("Правило добавлено и активировано");
        } else if (result.phase === "partial") {
          toast.error("Правило сохранено, но Mihomo не подтвердил активацию");
        } else if (result.phase === "queued") {
          toast.info("Правило принято. Применение продолжится после восстановления");
        } else {
          toast.info("Кандидат изменился — правило не добавлено");
        }
        await invalidate();
      },
      onError: () => toast.error("Не удалось добавить правило"),
      onSettled: (result, _error, variables) => {
        if (result?.phase === "queued") return;
        setApplyingFqdns((current) => {
          const next = new Set(current);
          next.delete(variables.fqdn);
          return next;
        });
      },
    }),
  );

  const loading = settingsQuery.isLoading || overviewQuery.isLoading;
  const failed = settingsQuery.isError || overviewQuery.isError;
  const settingsView = settingsQuery.data;
  const overview = overviewQuery.data;
  const applyReadiness = resolveApplyReadiness(settingsView);
  const candidateItems = candidatesQuery.data?.pages.flatMap((page) => page.items) ?? [];
  const exclusionItems = exclusionsQuery.data?.pages.flatMap((page) => page.items) ?? [];
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

  function applyCandidate(fqdn: string) {
    if (applyingFqdns.has(fqdn)) return;
    setApplyingFqdns((current) => new Set(current).add(fqdn));
    candidateApplyMutation.mutate({ fqdn, operationId: createManualApplyOperationId() });
  }

  return (
    <div className="responsive-page responsive-page--domain-intelligence page-content page-stack domain-intelligence-screen flex min-w-0 flex-col">
      <PageHeader
        title="Автоправила"
        subtitle="Домены, которым нужен VPN, попадают в список custom после проверки"
        actions={
          <Link
            to="/settings"
            aria-label="Настроить"
            className={cn(
              buttonVariants({ variant: "secondary", size: "headerIcon" }),
              "page-header-action domain-settings-link",
            )}
          >
            <Settings2 aria-hidden="true" size={18} />
            <span className="domain-settings-label">Настроить</span>
          </Link>
        }
      />

      {loading ? (
        <LoadingState />
      ) : failed || !settingsView || !overview || !applyReadiness ? (
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
              applyReadiness={applyReadiness}
              seenToday={seenToday}
              health={overview.health.status}
              pending={settingsMutation.isPending}
              onSelect={selectMode}
            />
          )}

          <CandidatePanel
            exclusionsOpen={exclusionsOpen}
            candidatesCount={overview.bucketCounts.candidate}
            exclusionsCount={overview.bucketCounts.exclusion}
            candidateItems={candidateItems}
            exclusionItems={exclusionItems}
            candidatesLoading={candidatesQuery.isLoading}
            candidatesFailed={candidatesQuery.isError}
            candidatesHaveMore={candidatesQuery.hasNextPage}
            candidatesLoadingMore={candidatesQuery.isFetchingNextPage}
            exclusionsLoading={exclusionsQuery.isLoading}
            exclusionsFailed={exclusionsQuery.isError}
            exclusionsHaveMore={exclusionsQuery.hasNextPage}
            exclusionsLoadingMore={exclusionsQuery.isFetchingNextPage}
            expanded={expanded}
            scopePending={scopeMutation.isPending}
            rejectionPending={rejectionMutation.isPending}
            recheckPending={recheckMutation.isPending}
            applyingFqdns={applyingFqdns}
            applyUnavailableMessage={candidateApplyUnavailableMessage(settingsView, applyReadiness)}
            onToggleExclusions={() => setExclusionsOpen((open) => !open)}
            onExpand={(fqdn) => setExpanded((current) => (current === fqdn ? null : fqdn))}
            onScope={(fqdn, selectedScope) => scopeMutation.mutate({ fqdn, selectedScope })}
            onReject={(fqdn, rejected) => rejectionMutation.mutate({ fqdn, rejected })}
            onRecheck={(fqdn) => recheckMutation.mutate({ fqdn })}
            onApply={applyCandidate}
            onRetryCandidates={() => void candidatesQuery.refetch()}
            onRetryExclusions={() => void exclusionsQuery.refetch()}
            onLoadMoreCandidates={() => void candidatesQuery.fetchNextPage()}
            onLoadMoreExclusions={() => void exclusionsQuery.fetchNextPage()}
          />

          <RuleStoreStatusCard applyReadiness={applyReadiness} />
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
  applyReadiness,
  seenToday,
  health,
  pending,
  onSelect,
}: {
  settings: DomainIntelligenceReportSettings;
  applyReadiness: DomainIntelligenceApplyReadiness;
  seenToday: number;
  health: "inactive" | "accumulating" | "healthy" | "degraded";
  pending: boolean;
  onSelect: (mode: "off" | "review") => void;
}) {
  const mode = settings.automationMode;
  const [modeEditorOpen, setModeEditorOpen] = useState(false);
  const automaticUnavailableMessage = applyReadiness.available
    ? "Автоматический режим ещё не подключён в интерфейсе"
    : applyActionUnavailableMessage(applyReadiness);
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
          className="domain-mode-segmented flex w-fit max-w-full flex-nowrap gap-[3px] rounded-md border border-border-subtle bg-canvas p-[3px]"
        >
          {(["off", "review", "automatic"] as const).map((option) => {
            const disabled = pending || option === "automatic";
            return (
              <button
                key={option}
                type="button"
                disabled={disabled}
                aria-current={mode === option ? "true" : undefined}
                title={option === "automatic" ? automaticUnavailableMessage : undefined}
                onClick={() => option !== "automatic" && onSelect(option)}
                className={cn(
                  "whitespace-nowrap rounded-sm px-[13px] py-[7px] text-sub font-medium transition-colors disabled:text-text-disabled",
                  mode === option
                    ? "bg-accent on-accent-fg disabled:bg-accent disabled:on-accent-fg"
                    : "text-text-secondary hover:text-text-primary",
                )}
              >
                {MODE_LABELS[option]}
              </button>
            );
          })}
        </fieldset>
        <button
          type="button"
          className="domain-mode-mobile-trigger min-h-11 w-full items-center justify-between gap-3 rounded-md border border-border-subtle bg-elevated px-3 py-2 text-left hover:bg-hover"
          aria-label={`Режим: ${MODE_LABELS[mode]}`}
          onClick={() => setModeEditorOpen(true)}
        >
          <span className="flex min-w-0 flex-col gap-0.5">
            <span className="text-micro font-semibold uppercase tracking-wide text-text-tertiary">
              Режим
            </span>
            <span className="truncate text-sub font-medium text-text-primary">
              {MODE_LABELS[mode]}
            </span>
          </span>
          <ChevronRight aria-hidden="true" className="shrink-0 text-text-tertiary" size={18} />
        </button>
        <p className="domain-mode-description text-meta text-text-tertiary">
          {MODE_DESCRIPTIONS[mode]}
        </p>
        {!applyReadiness.available ? (
          <p className="domain-mode-capability text-fine text-text-tertiary">
            {automaticUnavailableMessage}
          </p>
        ) : null}
      </div>
      <div
        role="status"
        aria-label={`${statusLabel}. ${seenToday} доменов сегодня по UTC`}
        className="domain-mode-status flex shrink-0 flex-col items-end gap-1.5 text-right"
      >
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
      {modeEditorOpen ? (
        <ResponsiveDialog
          title="Режим автоправил"
          description="Насколько самостоятельно Submerge меняет список custom"
          size="compact"
          onClose={() => setModeEditorOpen(false)}
        >
          <fieldset aria-label="Выбор режима автоправил" className="flex flex-col gap-2">
            {(["off", "review", "automatic"] as const).map((option) => {
              const selected = mode === option;
              const disabled = pending || option === "automatic";
              return (
                <button
                  key={option}
                  type="button"
                  disabled={disabled}
                  aria-pressed={selected}
                  title={option === "automatic" ? automaticUnavailableMessage : undefined}
                  className={cn(
                    "flex min-h-14 w-full items-center gap-3 rounded-md border px-3 py-2.5 text-left transition-colors disabled:opacity-50",
                    selected
                      ? "border-accent-border bg-accent-bg"
                      : "border-border-subtle bg-elevated hover:bg-hover",
                  )}
                  onClick={() => {
                    if (option === "automatic") return;
                    onSelect(option);
                    setModeEditorOpen(false);
                  }}
                >
                  <span
                    aria-hidden="true"
                    className={cn(
                      "flex h-5 w-5 shrink-0 items-center justify-center rounded-full border",
                      selected ? "border-accent" : "border-border-strong",
                    )}
                  >
                    {selected ? <span className="h-2.5 w-2.5 rounded-full bg-accent" /> : null}
                  </span>
                  <span className="flex min-w-0 flex-col gap-0.5">
                    <span className="text-sub font-medium text-text-primary">
                      {MODE_LABELS[option]}
                    </span>
                    <span className="text-fine text-text-tertiary">
                      {MODE_DESCRIPTIONS[option]}
                    </span>
                  </span>
                </button>
              );
            })}
          </fieldset>
        </ResponsiveDialog>
      ) : null}
    </section>
  );
}

function CandidatePanel({
  exclusionsOpen,
  candidatesCount,
  exclusionsCount,
  candidateItems,
  exclusionItems,
  candidatesLoading,
  candidatesFailed,
  candidatesHaveMore,
  candidatesLoadingMore,
  exclusionsLoading,
  exclusionsFailed,
  exclusionsHaveMore,
  exclusionsLoadingMore,
  expanded,
  scopePending,
  rejectionPending,
  recheckPending,
  applyingFqdns,
  applyUnavailableMessage,
  onToggleExclusions,
  onExpand,
  onScope,
  onReject,
  onRecheck,
  onApply,
  onRetryCandidates,
  onRetryExclusions,
  onLoadMoreCandidates,
  onLoadMoreExclusions,
}: {
  exclusionsOpen: boolean;
  candidatesCount: number;
  exclusionsCount: number;
  candidateItems: readonly DomainCandidateReportItem[];
  exclusionItems: readonly DomainCandidateReportItem[];
  candidatesLoading: boolean;
  candidatesFailed: boolean;
  candidatesHaveMore: boolean;
  candidatesLoadingMore: boolean;
  exclusionsLoading: boolean;
  exclusionsFailed: boolean;
  exclusionsHaveMore: boolean;
  exclusionsLoadingMore: boolean;
  expanded: string | null;
  scopePending: boolean;
  rejectionPending: boolean;
  recheckPending: boolean;
  applyingFqdns: ReadonlySet<string>;
  applyUnavailableMessage: string | null;
  onToggleExclusions: () => void;
  onExpand: (fqdn: string) => void;
  onScope: (fqdn: string, scope: DomainRuleScope) => void;
  onReject: (fqdn: string, rejected: boolean) => void;
  onRecheck: (fqdn: string) => void;
  onApply: (fqdn: string) => void;
  onRetryCandidates: () => void;
  onRetryExclusions: () => void;
  onLoadMoreCandidates: () => void;
  onLoadMoreExclusions: () => void;
}) {
  const desktopExclusionsTriggerRef = useRef<HTMLButtonElement>(null);
  const mobileExclusionsTriggerRef = useRef<HTMLButtonElement>(null);
  const candidatesBackRef = useRef<HTMLButtonElement>(null);

  function openExclusions() {
    onToggleExclusions();
    requestAnimationFrame(() => candidatesBackRef.current?.focus());
  }

  function collapseExclusions() {
    onToggleExclusions();
    requestAnimationFrame(() => {
      const triggers = [desktopExclusionsTriggerRef.current, mobileExclusionsTriggerRef.current];
      const visibleTrigger = triggers.find(
        (trigger) => trigger && trigger.getClientRects().length > 0,
      );
      (
        visibleTrigger ??
        desktopExclusionsTriggerRef.current ??
        mobileExclusionsTriggerRef.current
      )?.focus();
    });
  }

  return (
    <section
      className={cn(
        "domain-candidate-panel overflow-hidden rounded-lg border border-border-subtle bg-surface",
        !exclusionsOpen && "domain-candidate-panel--candidates",
        !exclusionsOpen && candidateItems.length > 0 && "domain-candidate-panel--cards",
      )}
    >
      {exclusionsOpen ? (
        <>
          <header className="flex min-h-12 items-center justify-between gap-3 border-b border-border-subtle bg-elevated px-[18px] py-2.5">
            <button
              ref={candidatesBackRef}
              type="button"
              aria-label="К кандидатам"
              onClick={collapseExclusions}
              className="inline-flex min-h-8 min-w-0 items-center gap-2 text-text-primary"
            >
              <ChevronLeft aria-hidden="true" size={15} className="shrink-0 text-text-secondary" />
              <span className="text-label font-semibold">Исключения</span>
              <span className="text-meta font-normal text-text-tertiary">
                {domainCountLabel(exclusionsCount)}
              </span>
            </button>
            <Link
              to="/settings"
              aria-label="Настроить фильтры"
              className="shrink-0 text-meta font-semibold text-accent-text"
            >
              <span className="domain-exclusions-settings-full">Настроить фильтры</span>
              <span className="domain-exclusions-settings-mobile">Фильтры</span>
            </Link>
          </header>
          <div id="domain-exclusions">
            <div className="flex items-center gap-2 border-b border-border-subtle bg-elevated px-[18px] py-2.5 text-fine text-text-tertiary">
              <Shield aria-hidden="true" size={14} className="shrink-0" />
              <p>
                Фильтры останавливают автоматическое предложение, но своё правило всегда можно
                добавить вручную.
              </p>
            </div>
            <CandidateListBody
              view="exclusions"
              items={exclusionItems}
              loading={exclusionsLoading}
              failed={exclusionsFailed}
              hasMore={exclusionsHaveMore}
              loadingMore={exclusionsLoadingMore}
              expanded={expanded}
              scopePending={scopePending}
              rejectionPending={rejectionPending}
              recheckPending={recheckPending}
              applyingFqdns={applyingFqdns}
              applyUnavailableMessage={applyUnavailableMessage}
              onExpand={onExpand}
              onScope={onScope}
              onReject={onReject}
              onRecheck={onRecheck}
              onApply={onApply}
              onRetry={onRetryExclusions}
              onLoadMore={onLoadMoreExclusions}
            />
          </div>
        </>
      ) : (
        <>
          <header className="flex min-h-12 items-center justify-between gap-3 border-b border-border-subtle bg-elevated px-[18px] py-2.5">
            <div className="inline-flex min-w-0 items-center gap-2 text-label font-semibold text-text-primary">
              <span>Ждут подтверждения</span>
              <span
                className={cn(
                  "rounded-full px-2 py-0.5 font-mono text-fine font-bold",
                  candidatesCount > 0 ? "bg-accent on-accent-fg" : "bg-hover text-text-tertiary",
                )}
              >
                {candidatesCount}
              </span>
            </div>
            <button
              ref={desktopExclusionsTriggerRef}
              type="button"
              onClick={openExclusions}
              className="domain-exclusions-trigger-header inline-flex min-h-8 items-center gap-1.5 text-meta font-medium text-text-tertiary hover:text-text-secondary"
            >
              Исключения · {exclusionsCount}
              <ChevronRight aria-hidden="true" size={14} />
            </button>
          </header>
          <CandidateListBody
            view="candidates"
            items={candidateItems}
            loading={candidatesLoading}
            failed={candidatesFailed}
            hasMore={candidatesHaveMore}
            loadingMore={candidatesLoadingMore}
            expanded={expanded}
            scopePending={scopePending}
            rejectionPending={rejectionPending}
            recheckPending={recheckPending}
            applyingFqdns={applyingFqdns}
            applyUnavailableMessage={applyUnavailableMessage}
            onExpand={onExpand}
            onScope={onScope}
            onReject={onReject}
            onRecheck={onRecheck}
            onApply={onApply}
            onRetry={onRetryCandidates}
            onLoadMore={onLoadMoreCandidates}
          />
          <button
            ref={mobileExclusionsTriggerRef}
            type="button"
            onClick={openExclusions}
            className="domain-exclusions-trigger-mobile min-h-11 w-full items-center justify-center gap-1.5 border-t border-border-subtle text-meta font-medium text-text-tertiary hover:text-text-secondary"
          >
            Исключения · {exclusionsCount}
            <ChevronRight aria-hidden="true" size={14} />
          </button>
        </>
      )}
    </section>
  );
}

function CandidateListBody({
  view,
  items,
  loading,
  failed,
  hasMore,
  loadingMore,
  expanded,
  scopePending,
  rejectionPending,
  recheckPending,
  applyingFqdns,
  applyUnavailableMessage,
  onExpand,
  onScope,
  onReject,
  onRecheck,
  onApply,
  onRetry,
  onLoadMore,
}: {
  view: CandidateView;
  items: readonly DomainCandidateReportItem[];
  loading: boolean;
  failed: boolean;
  hasMore: boolean;
  loadingMore: boolean;
  expanded: string | null;
  scopePending: boolean;
  rejectionPending: boolean;
  recheckPending: boolean;
  applyingFqdns: ReadonlySet<string>;
  applyUnavailableMessage: string | null;
  onExpand: (fqdn: string) => void;
  onScope: (fqdn: string, scope: DomainRuleScope) => void;
  onReject: (fqdn: string, rejected: boolean) => void;
  onRecheck: (fqdn: string) => void;
  onApply: (fqdn: string) => void;
  onRetry: () => void;
  onLoadMore: () => void;
}) {
  return loading ? (
    <div className="flex flex-col gap-2 p-4">
      <Skeleton className="h-[62px] w-full rounded-md" />
      <Skeleton className="h-[62px] w-full rounded-md" />
    </div>
  ) : failed ? (
    <div className="flex min-h-40 flex-col items-center justify-center gap-3 px-6 py-8 text-center">
      <div className="flex flex-col gap-1.5">
        <h3 className="text-cardtitle text-text-primary">Не удалось загрузить список доменов</h3>
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
          ? "Submerge продолжает наблюдать. Домен появится здесь после нескольких DIRECT-сбоев и успешных проверок через VPN."
          : "Отклонённые и заблокированные кандидаты появятся здесь с причиной."}
      </p>
    </div>
  ) : (
    <>
      <div
        className={cn(
          "divide-y divide-border-subtle",
          view === "candidates" && "domain-candidate-list",
        )}
      >
        {items.map((item) =>
          view === "exclusions" ? (
            <ExclusionRow
              key={item.fqdn}
              item={item}
              rejectionPending={rejectionPending}
              recheckPending={recheckPending}
              onReject={(rejected) => onReject(item.fqdn, rejected)}
              onRecheck={() => onRecheck(item.fqdn)}
            />
          ) : (
            <CandidateRow
              key={item.fqdn}
              item={item}
              expanded={expanded === item.fqdn}
              scopePending={scopePending}
              rejectionPending={rejectionPending}
              recheckPending={recheckPending}
              applyPending={applyingFqdns.has(item.fqdn)}
              applyUnavailableMessage={applyUnavailableMessage}
              onExpand={() => onExpand(item.fqdn)}
              onScope={(scope) => onScope(item.fqdn, scope)}
              onReject={(rejected) => onReject(item.fqdn, rejected)}
              onRecheck={() => onRecheck(item.fqdn)}
              onApply={() => onApply(item.fqdn)}
            />
          ),
        )}
      </div>
      {hasMore ? (
        <div className="flex justify-center border-t border-border-subtle p-3">
          <Button variant="secondary" size="sm" disabled={loadingMore} onClick={onLoadMore}>
            {loadingMore ? "Загрузка…" : "Загрузить ещё"}
          </Button>
        </div>
      ) : null}
    </>
  );
}

function ExclusionRow({
  item,
  rejectionPending,
  recheckPending,
  onReject,
  onRecheck,
}: {
  item: DomainCandidateReportItem;
  rejectionPending: boolean;
  recheckPending: boolean;
  onReject: (rejected: boolean) => void;
  onRecheck: () => void;
}) {
  const observedDomain = observedDomainParts(item.fqdn, item.siteGroup);
  return (
    <article className="domain-candidate-row domain-exclusion-row flex min-w-0 items-center gap-3.5 px-[18px] py-[11px]">
      <div className="min-w-0 flex-1">
        <span
          title={item.fqdn}
          className="domain-observed-name min-w-0 font-mono text-sub text-text-secondary"
        >
          {observedDomain.prefix ? (
            <span className="domain-observed-prefix">{observedDomain.prefix}</span>
          ) : null}
          <span className="domain-observed-suffix">{observedDomain.suffix}</span>
        </span>
        <p className="mt-1 text-fine text-text-tertiary">{exclusionText(item)}</p>
      </div>
      <span className="domain-exclusion-reason w-fit shrink-0 rounded-full bg-hover px-[9px] py-[3px] text-micro font-medium text-text-secondary">
        {exclusionReasonLabel(item.exclusionReason)}
      </span>
      <div className="domain-candidate-actions flex shrink-0 items-center justify-end">
        <ExclusionAction
          item={item}
          pending={item.reviewState === "rejected" ? rejectionPending : recheckPending}
          onRestore={() => onReject(false)}
          onRecheck={onRecheck}
        />
      </div>
    </article>
  );
}

function domainCountLabel(count: number): string {
  const mod100 = count % 100;
  const mod10 = count % 10;
  const noun =
    mod100 >= 11 && mod100 <= 14
      ? "доменов"
      : mod10 === 1
        ? "домен"
        : mod10 >= 2 && mod10 <= 4
          ? "домена"
          : "доменов";
  return `${count} ${noun}`;
}

function CandidateRow({
  item,
  expanded,
  scopePending,
  rejectionPending,
  recheckPending,
  applyPending,
  applyUnavailableMessage,
  onExpand,
  onScope,
  onReject,
  onRecheck,
  onApply,
}: {
  item: DomainCandidateReportItem;
  expanded: boolean;
  scopePending: boolean;
  rejectionPending: boolean;
  recheckPending: boolean;
  applyPending: boolean;
  applyUnavailableMessage: string | null;
  onExpand: () => void;
  onScope: (scope: DomainRuleScope) => void;
  onReject: (rejected: boolean) => void;
  onRecheck: () => void;
  onApply: () => void;
}) {
  const exactOnly = item.eligibleScopes.length === 1 && item.eligibleScopes[0] === "exact";
  const observedDomain = observedDomainParts(item.fqdn, item.siteGroup);
  const scopeLabel =
    item.bucket !== "candidate" || item.selectedScope === null
      ? null
      : item.selectedScope === "site"
        ? "сайт целиком"
        : "только точный адрес";
  const addUnavailableMessage = applyUnavailableMessage;
  const identity = (
    <>
      <div
        className={cn(
          "domain-candidate-rule min-w-0",
          item.proposedRule && "domain-candidate-rule--with-proposal",
        )}
      >
        <span
          title={item.fqdn}
          className="domain-observed-name min-w-0 font-mono text-sub text-text-secondary"
        >
          <Eye aria-hidden="true" size={11} className="domain-observed-eye shrink-0" />
          {observedDomain.prefix ? (
            <span className="domain-observed-prefix">{observedDomain.prefix}</span>
          ) : null}
          <span className="domain-observed-suffix">{observedDomain.suffix}</span>
        </span>
        {item.proposedRule ? (
          <span className="domain-candidate-proposal min-w-0">
            <span className="domain-generated-group min-w-0">
              <ArrowRight aria-hidden="true" size={13} className="shrink-0 text-text-disabled" />
              <code className="domain-generated-rule font-mono text-sub font-semibold text-text-primary">
                {item.proposedRule}
              </code>
            </span>
            {scopeLabel ? (
              <span
                className={cn(
                  "domain-rule-scope inline-flex shrink-0 items-center rounded-full px-[7px] py-0.5 text-micro font-medium",
                  exactOnly ? "bg-slow-bg text-slow" : "bg-hover text-text-secondary",
                )}
              >
                {scopeLabel}
              </span>
            ) : null}
          </span>
        ) : null}
      </div>
      <p
        className={cn(
          "domain-candidate-summary mt-1 text-fine text-text-tertiary",
          exactOnly && "domain-candidate-summary--exact",
        )}
      >
        {candidateSummary(item)}
      </p>
      {exactOnly ? (
        <p className="domain-candidate-summary-compact mt-1 text-fine text-text-secondary">
          {exactScopeExplanation(item)}
        </p>
      ) : null}
      {!exactOnly ? (
        <span className="domain-candidate-details-hint mt-2 items-center gap-1 text-fine font-medium text-accent-text">
          {expanded ? "Скрыть" : "Подробнее"}
          <ChevronDown
            aria-hidden="true"
            size={14}
            className={cn("transition-transform", expanded && "rotate-180")}
          />
        </span>
      ) : null}
    </>
  );
  return (
    <article className="domain-candidate-item min-w-0">
      <div
        className={cn(
          "domain-candidate-row min-w-0 px-[18px] py-[13px]",
          expanded && "bg-elevated",
        )}
      >
        <div className="domain-candidate-copy relative min-w-0 flex-1">
          {identity}
          {!exactOnly ? (
            <button
              type="button"
              aria-label={`${expanded ? "Скрыть" : "Открыть"} детали ${item.fqdn}`}
              aria-expanded={expanded}
              onClick={onExpand}
              className="domain-candidate-copy-trigger absolute inset-0 hidden rounded-md focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
            />
          ) : null}
        </div>
        <div className="domain-candidate-actions domain-candidate-review-actions shrink-0">
          {item.bucket === "candidate" ? (
            <>
              <Button
                variant="ghost"
                size="sm"
                disabled={rejectionPending}
                aria-label={`Не добавлять ${item.fqdn}`}
                onClick={() => onReject(true)}
                className="domain-candidate-reject-action border border-transparent"
              >
                Не добавлять
              </Button>
              {item.status === "confirmed" ? (
                <Button
                  variant={addUnavailableMessage === null ? "primary" : "secondary"}
                  size="sm"
                  aria-label={`${applyPending ? "Добавляется" : "Добавить"} ${item.fqdn}`}
                  aria-busy={applyPending || undefined}
                  aria-disabled={
                    applyPending || addUnavailableMessage !== null ? "true" : undefined
                  }
                  aria-describedby={
                    addUnavailableMessage === null ? undefined : `domain-add-state-${item.fqdn}`
                  }
                  className={cn(
                    "domain-candidate-apply-action",
                    addUnavailableMessage !== null &&
                      "cursor-not-allowed border-border-subtle bg-hover text-text-disabled hover:bg-hover [&_svg]:text-text-disabled",
                  )}
                  onClick={() => {
                    if (applyPending) return;
                    if (addUnavailableMessage === null) onApply();
                    else if (addUnavailableMessage) toast.info(addUnavailableMessage);
                  }}
                >
                  <Plus aria-hidden="true" size={14} />
                  {applyPending ? "В работе…" : "Добавить"}
                </Button>
              ) : (
                <span
                  role="status"
                  aria-label="Проверяется"
                  className={cn(
                    buttonVariants({ variant: "secondary", size: "sm" }),
                    "domain-candidate-apply-action cursor-default border-border-subtle bg-hover text-text-disabled",
                  )}
                >
                  Проверяется
                </span>
              )}
              {item.status === "confirmed" && addUnavailableMessage ? (
                <span id={`domain-add-state-${item.fqdn}`} className="sr-only">
                  {addUnavailableMessage}
                </span>
              ) : null}
              {item.status === "confirmed" && applyPending ? (
                <span role="status" aria-live="polite" className="sr-only">
                  Правило для {item.fqdn} добавляется
                </span>
              ) : null}
            </>
          ) : (
            <ExclusionAction
              item={item}
              pending={item.reviewState === "rejected" ? rejectionPending : recheckPending}
              onRestore={() => onReject(false)}
              onRecheck={onRecheck}
            />
          )}
          {item.bucket === "candidate" && !exactOnly ? (
            <button
              type="button"
              aria-label={`Подробнее о ${item.fqdn}`}
              aria-expanded={expanded}
              onClick={onExpand}
              className="domain-candidate-expand flex h-8 w-8 items-center justify-center rounded-md text-text-disabled hover:bg-hover hover:text-text-secondary"
            >
              <ChevronDown
                aria-hidden="true"
                size={16}
                className={cn("transition-transform", expanded && "rotate-180")}
              />
            </button>
          ) : item.bucket === "candidate" ? (
            <span aria-hidden="true" className="domain-candidate-expand-spacer h-8 w-8" />
          ) : null}
        </div>
      </div>
      {exactOnly && item.bucket === "candidate" ? (
        <div className="domain-exact-scope-note flex items-start gap-2.5 border-t border-border-subtle bg-canvas px-[18px] py-3 text-fine text-text-secondary">
          <Shield aria-hidden="true" size={15} className="mt-0.5 shrink-0 text-slow" />
          <p>{exactScopeExplanation(item)}</p>
        </div>
      ) : null}
      {expanded && item.bucket === "candidate" && !exactOnly ? (
        <div className="flex flex-col gap-[11px] border-t border-border-subtle bg-canvas px-[18px] pb-4 pt-3.5">
          <EvidenceRows item={item} />
          <DetailRow label="ОБЛАСТЬ" tone="accent">
            <div className="domain-candidate-scope flex min-w-0 flex-wrap items-center gap-3">
              <ScopeButtons
                value={item.selectedScope}
                siteDisabled={!item.eligibleScopes.some((scope) => scope === "site")}
                pending={scopePending}
                siteLabel={`+.${item.siteGroup}`}
                exactLabel={item.fqdn}
                ruleLabels
                onChange={onScope}
              />
              <span className="text-fine text-text-tertiary">
                {item.selectedScope === "site"
                  ? "сайт и все поддомены"
                  : "только наблюдавшийся адрес"}
              </span>
            </div>
          </DetailRow>
          <div className="domain-candidate-detail-footer flex items-center justify-between gap-4 border-t border-border-subtle pt-3">
            <p className="min-w-0 text-fine text-text-tertiary">
              Наблюдался один адрес; правило для сайта не возвращает тот же домен кандидатом по
              каждому поддомену. Суффиксы из «Не расширять» остаются точными.
            </p>
            <Button
              variant="secondary"
              size="sm"
              disabled={recheckPending}
              className="shrink-0 whitespace-nowrap"
              onClick={onRecheck}
            >
              <RefreshCw aria-hidden="true" size={14} />
              Проверить сейчас
            </Button>
          </div>
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
      <Button size="sm" variant="secondary" disabled={pending} onClick={onRestore}>
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
    item.status === "excluded" ||
    item.exclusionReason === "telemetry-pattern" ||
    item.exclusionReason === "never-add-domain" ||
    item.exclusionReason === "never-add-suffix" ||
    item.exclusionReason === "excluded-tld" ||
    item.exclusionReason === "invalid-policy"
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
  siteLabel = "Сайт целиком",
  exactLabel = "Только точный адрес",
  ruleLabels = false,
  onChange,
}: {
  value: DomainRuleScope | null;
  siteDisabled: boolean;
  pending?: boolean;
  siteLabel?: string;
  exactLabel?: string;
  ruleLabels?: boolean;
  onChange: (scope: DomainRuleScope) => void;
}) {
  return (
    <fieldset
      aria-label="Область правила"
      className={cn(
        "flex w-fit max-w-full gap-[3px] rounded-md border border-border-subtle bg-canvas p-[3px]",
        ruleLabels && "domain-candidate-scope-picker",
      )}
    >
      <button
        type="button"
        disabled={pending || siteDisabled}
        aria-current={value === "site" ? "true" : undefined}
        onClick={() => onChange("site")}
        className={scopeButtonClass(value === "site")}
      >
        {siteLabel}
      </button>
      <button
        type="button"
        disabled={pending}
        aria-current={value === "exact" ? "true" : undefined}
        onClick={() => onChange("exact")}
        className={scopeButtonClass(value === "exact")}
      >
        {exactLabel}
      </button>
    </fieldset>
  );
}

function scopeButtonClass(active: boolean) {
  return cn(
    "rounded-sm px-3 py-[7px] text-sub font-medium transition-colors disabled:text-text-disabled",
    active ? "bg-accent on-accent-fg" : "text-text-secondary hover:text-text-primary",
  );
}

function EvidenceRows({ item }: { item: DomainCandidateReportItem }) {
  if (item.evidenceIntegrityIssue !== null) {
    return (
      <div className="rounded-md border border-timeout/30 bg-timeout-bg px-3 py-2.5 text-fine text-text-secondary">
        Доказательства недоступны: требуется повторная проверка кандидата.
      </div>
    );
  }
  const directView = probeAttemptView(item.latestAttempts.direct);
  const proxyView = probeAttemptView(item.latestAttempts.proxy);
  const evidence = item.decision?.evidence;
  const windowHours = item.decision?.windowStart
    ? Math.max(1, Math.round((item.decision.evaluatedAt - item.decision.windowStart) / 3_600_000))
    : null;
  return (
    <>
      <DetailRow label="DIRECT" tone={directView.tone}>
        {evidence && windowHours
          ? `${evidence.directQualifyingFailures} DIRECT-сбоя за ${windowHours} ч · последний: ${directView.value}`
          : directView.value}
      </DetailRow>
      <DetailRow label="PROXY" tone={proxyView.tone}>
        {evidence
          ? `${evidence.proxyHttpSuccesses} успешных PROXY-проверок · последний: ${proxyView.value}`
          : proxyView.value}
      </DetailRow>
      <DetailRow label="ПОКРЫТИЕ">
        {item.status === "confirmed" &&
        item.evidenceAvailable &&
        item.decision?.status === "confirmed"
          ? "не покрыт активными правилами и списками"
          : "повторно проверяется перед применением"}
      </DetailRow>
    </>
  );
}

function DetailRow({
  label,
  children,
  tone,
}: {
  label: string;
  children: ReactNode;
  tone?: "danger" | "success" | "accent" | undefined;
}) {
  return (
    <div className="domain-candidate-detail-row grid min-w-0 items-center gap-3.5">
      <span
        className={cn(
          "font-mono text-caption font-semibold tracking-wide",
          tone === "danger"
            ? "text-timeout"
            : tone === "success"
              ? "text-online"
              : tone === "accent"
                ? "text-accent-text"
                : "text-text-tertiary",
        )}
      >
        {label}
      </span>
      <div className="min-w-0 text-sub text-text-secondary">{children}</div>
    </div>
  );
}

function applyActionUnavailableMessage(applyReadiness: DomainIntelligenceApplyReadiness): string {
  if (applyReadiness.available) return "Добавление из интерфейса ещё не подключено";
  switch (applyReadiness.reason) {
    case "deployment-report-only":
      return "Применение недоступно, пока сервер работает в режиме только отчёта";
    case "local-store-unavailable":
      return "Применение недоступно: локальное хранилище правил не подготовлено";
    case "local-store-unsafe":
      return "Применение недоступно: локальное хранилище правил не прошло проверку безопасности";
    case "local-store-migration-required":
      return "Применение недоступно: требуется перенос существующего списка custom";
    case "local-store-reconciliation-required":
      return "Применение недоступно: локальный список требует восстановления";
    case "provider-inactive":
      return "Применение недоступно: Mihomo не подтвердил локальный provider";
    case "target-channel-unavailable":
      return "Применение недоступно: целевой VPN-канал не готов";
  }
}

function ruleStoreStatusCopy(applyReadiness: DomainIntelligenceApplyReadiness): {
  badge: string;
  description: string;
} {
  if (applyReadiness.available) {
    return {
      badge: "готово",
      description: "Локальный список готов к применению.",
    };
  }
  switch (applyReadiness.reason) {
    case "deployment-report-only":
      return {
        badge: "только отчёт",
        description: "Применение отключено в конфигурации сервера. Отчёт и проверки работают.",
      };
    case "local-store-unavailable":
      return {
        badge: "не готово",
        description: "Локальное хранилище правил ещё не подготовлено.",
      };
    case "local-store-unsafe":
      return {
        badge: "требует внимания",
        description: "Локальное хранилище правил не прошло проверку безопасности.",
      };
    case "local-store-migration-required":
      return {
        badge: "нужен перенос",
        description: "Перед применением нужно безопасно перенести существующий список custom.",
      };
    case "local-store-reconciliation-required":
      return {
        badge: "нужно восстановление",
        description: "Локальный список требует восстановления перед применением.",
      };
    case "provider-inactive":
      return {
        badge: "provider не активен",
        description: "Mihomo ещё не подтвердил локальный provider.",
      };
    case "target-channel-unavailable":
      return {
        badge: "канал не готов",
        description: "Целевой VPN-канал недоступен для применения правил.",
      };
  }
}

function RuleStoreStatusCard({
  applyReadiness,
}: {
  applyReadiness: DomainIntelligenceApplyReadiness;
}) {
  const copy = ruleStoreStatusCopy(applyReadiness);
  return (
    <section className="flex min-w-0 items-center justify-between gap-4 rounded-lg border border-border-subtle bg-surface px-[18px] py-4">
      <div className="flex min-w-0 flex-col gap-1">
        <h2 className="text-label font-semibold text-text-primary">Список custom</h2>
        <p className="text-sub text-text-secondary">{copy.description}</p>
      </div>
      <span className="shrink-0 rounded-full bg-hover px-2.5 py-1 text-fine font-medium text-text-tertiary">
        {copy.badge}
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
    return `Адрес входит в список «Не расширять»: +.${item.siteGroup} могло бы увести в VPN чужие сайты. Домен остаётся допустимым кандидатом, но правило создаётся только на точный адрес.`;
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
  if (reason === "user-rejected") return "Вы нажали «Не добавлять»";
  if (reason === "proxy-unstable") return "Через VPN тоже отвечает нестабильно";
  if (reason === "already-covered") return "Уже покрыт активным правилом или списком";
  if (reason === "telemetry-pattern") return "Совпал с шаблоном телеметрии";
  if (reason === "never-add-domain" || reason === "never-add-suffix") {
    return "Совпал со списком «Не добавлять»";
  }
  if (reason === "invalid-policy") return "Политика фильтрации недоступна или некорректна";
  if (reason === "invalid-evidence") return "Доказательства не прошли проверку целостности";
  if (reason === "observer-unhealthy") return "Наблюдение сейчас не даёт надёжных данных";
  if (reason === "insufficient-observations") return "Недостаточно независимых наблюдений";
  if (reason === "candidate-excluded") return "Домен исключён текущей политикой";
  if (reason === "invalid-scope") return "Выбранная область правила больше недоступна";
  if (reason === "coverage-incomplete") return "Покрытие активными правилами не подтверждено";
  if (reason === "proxy-evidence-uncertain") return "Работа через VPN не подтверждена надёжно";
  if (reason === "insufficient-direct-failures") return "Недостаточно независимых DIRECT-сбоев";
  if (reason === "direct-failures-not-spaced") return "DIRECT-сбои произошли слишком близко";
  if (reason === "direct-address-diversity-missing")
    return "DIRECT-сбои не подтверждены на разных адресах";
  if (reason === "insufficient-proxy-successes") return "Недостаточно успешных проверок через VPN";
  return "Предложение заблокировано текущей политикой";
}

function exclusionReasonLabel(reason: DomainReportExclusionReason | null): string {
  if (reason === "user-rejected") return "Отклонён вами";
  if (reason === "proxy-unstable") return "Не помогает VPN";
  if (reason === "already-covered") return "Уже покрыт";
  if (reason === "telemetry-pattern") return "Телеметрия";
  if (reason === "never-add-domain" || reason === "never-add-suffix") return "Не добавлять";
  if (reason === "excluded-tld") return "Зона исключена";
  if (reason === "invalid-policy") return "Политика недоступна";
  if (reason === "invalid-evidence") return "Данные неполны";
  if (reason === "observer-unhealthy") return "Наблюдение неполно";
  if (reason === "insufficient-observations") return "Мало наблюдений";
  if (reason === "candidate-excluded") return "Исключён политикой";
  if (reason === "invalid-scope") return "Область недоступна";
  if (reason === "coverage-incomplete") return "Покрытие неясно";
  if (reason === "proxy-evidence-uncertain") return "VPN не подтверждён";
  if (reason === "direct-failures-not-spaced") return "Сбои слишком близко";
  if (reason === "direct-address-diversity-missing") return "Мало адресов";
  return "Недостаточно проверок";
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
