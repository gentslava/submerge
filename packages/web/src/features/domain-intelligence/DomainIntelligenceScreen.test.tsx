import {
  DEFAULT_DOMAIN_INTELLIGENCE_REPORT_SETTINGS,
  type DomainCandidateList,
  type DomainIntelligenceOverview,
  type DomainIntelligenceSettingsView,
} from "@submerge/shared";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DomainIntelligenceScreen } from "./DomainIntelligenceScreen";

const now = Date.parse("2026-08-04T12:00:00.000Z");

const mocks = vi.hoisted(() => ({
  queryStates: new Map<string, unknown>(),
  mutationStates: new Map<
    string,
    {
      mutate: ReturnType<typeof vi.fn>;
      isPending: boolean;
      variables?: { fqdn: string };
      callbacks?: {
        onSuccess?: (result: unknown) => void;
        onError?: () => void;
        onSettled?: (result: unknown, error: unknown, variables: { fqdn: string }) => void;
      };
    }
  >(),
  queryOptions: vi.fn((kind: string) => ({ kind })),
  listQueryOptions: vi.fn((input: unknown) => ({ kind: "list", input })),
  mutationOptions: vi.fn((kind: string, options: unknown) => ({ kind, options })),
  invalidateQueries: vi.fn(),
  setQueryData: vi.fn(),
  toast: { error: vi.fn(), info: vi.fn(), success: vi.fn() },
}));

vi.mock("@tanstack/react-query", () => ({
  useQuery: (options: { kind: string; input?: { view?: string } }) =>
    mocks.queryStates.get(
      options.kind === "list" ? `list:${options.input?.view ?? "unknown"}` : options.kind,
    ),
  useInfiniteQuery: (options: { kind: string; input?: { view?: string } }) => {
    const state = mocks.queryStates.get(
      options.kind === "list" ? `list:${options.input?.view ?? "unknown"}` : options.kind,
    ) as
      | {
          data?: DomainCandidateList;
          isLoading: boolean;
          isError: boolean;
          isFetching: boolean;
          refetch: ReturnType<typeof vi.fn>;
          fetchNextPage?: ReturnType<typeof vi.fn>;
        }
      | undefined;
    if (!state) return state;
    return {
      ...state,
      data: state.data ? { pages: [state.data], pageParams: [undefined] } : undefined,
      hasNextPage: state.data?.nextCursor != null,
      isFetchingNextPage: false,
      fetchNextPage: state.fetchNextPage ?? vi.fn(),
    };
  },
  useMutation: (options: {
    kind: string;
    options?: {
      onSuccess?: (result: unknown) => void;
      onError?: () => void;
      onSettled?: (result: unknown, error: unknown, variables: { fqdn: string }) => void;
    };
  }) => {
    const state = mocks.mutationStates.get(options.kind);
    if (state && options.options) state.callbacks = options.options;
    return state;
  },
  useQueryClient: () => ({
    invalidateQueries: mocks.invalidateQueries,
    setQueryData: mocks.setQueryData,
  }),
}));

vi.mock("sonner", () => ({ toast: mocks.toast }));

vi.mock("@/lib/trpc", () => ({
  useTRPC: () => ({
    domainIntelligence: {
      settings: {
        queryOptions: () => mocks.queryOptions("settings"),
        queryKey: () => ["domain-intelligence", "settings"],
      },
      overview: {
        queryOptions: () => mocks.queryOptions("overview"),
        queryKey: () => ["domain-intelligence", "overview"],
      },
      list: {
        infiniteQueryOptions: mocks.listQueryOptions,
        infiniteQueryKey: () => ["domain-intelligence", "list", "infinite"],
      },
      setSettings: {
        mutationOptions: (options: unknown) => mocks.mutationOptions("settings", options),
      },
      setScope: { mutationOptions: (options: unknown) => mocks.mutationOptions("scope", options) },
      setRejected: {
        mutationOptions: (options: unknown) => mocks.mutationOptions("rejected", options),
      },
      recheck: { mutationOptions: (options: unknown) => mocks.mutationOptions("recheck", options) },
      applyCandidate: {
        mutationOptions: (options: unknown) => mocks.mutationOptions("apply", options),
      },
    },
  }),
}));

vi.mock("@tanstack/react-router", () => ({
  Link: ({ children, to, ...props }: { children: ReactNode; to: string }) => (
    <a href={to} {...props}>
      {children}
    </a>
  ),
}));

function settingsView(
  overrides: Partial<DomainIntelligenceSettingsView> = {},
): DomainIntelligenceSettingsView {
  return {
    configurationState: "ready",
    settings: {
      ...DEFAULT_DOMAIN_INTELLIGENCE_REPORT_SETTINGS,
      enabled: true,
      defaultRuleScope: "site",
      automationMode: "review",
    },
    deployment: {
      mode: "report",
      apply: { available: false, reason: "deployment-report-only" },
    },
    ...overrides,
  };
}

const overview: DomainIntelligenceOverview = {
  generatedAt: now,
  period: { from: now - 24 * 60 * 60 * 1_000, to: now },
  health: {
    status: "healthy",
    reason: "correlated",
    snapshotDomainConnections: 12,
    correlatedConnections: 10,
    updatedAt: now,
  },
  dailyAggregates: [{ day: "2026-08-04", connectionCount: 67, uniqueDomainCount: 18 }],
  candidateCounts: { queued: 0, pending: 0, confirmed: 2, blocked: 1, excluded: 1 },
  bucketCounts: { candidate: 2, exclusion: 2 },
  evidenceIntegrityCounts: { missingDecisions: 0, invalidDecisions: 0 },
  exclusionCounts: [
    { reason: "proxy-unstable", count: 1 },
    { reason: "telemetry-pattern", count: 1 },
  ],
};

const confirmedDecision = {
  evaluatedAt: now,
  status: "confirmed" as const,
  confidence: "high" as const,
  reasons: [],
  windowStart: now - 24 * 60 * 60 * 1_000,
  evidence: {
    directQualifyingFailures: 3,
    directSpacedFailures: 3,
    directAddressDiversityRequired: false,
    directAddressDiversitySatisfied: true,
    proxyHttpSuccesses: 2,
    proxyTransportFailures: 0,
    proxyUncertainFailures: 0,
  },
};

const candidates: DomainCandidateList = {
  nextCursor: null,
  items: [
    {
      fqdn: "www.service.example",
      siteGroup: "service.example",
      bucket: "candidate",
      reviewState: "active",
      status: "confirmed",
      selectedScope: "site",
      proposedRule: "+.service.example",
      eligibleScopes: ["exact", "site"],
      scopeValid: true,
      siteUnavailableReason: null,
      exclusionReason: null,
      policyExclusionReason: null,
      firstSeenAt: now - 24 * 60 * 60 * 1_000,
      lastSeenAt: now,
      lastValidationAt: now,
      nextValidationAt: now + 60_000,
      connectionCount: 47,
      evidenceAvailable: true,
      evidenceIntegrityIssue: null,
      decision: confirmedDecision,
      latestAttempts: {
        direct: {
          attemptedAt: now,
          category: "connect_timeout",
          transportSuccess: false,
          httpStatus: null,
          connectDurationMs: 8_000,
          tlsDurationMs: null,
          totalDurationMs: 8_000,
          redirectCount: 0,
          finalOrigin: "https://www.service.example",
        },
        proxy: {
          attemptedAt: now,
          category: "http_response",
          transportSuccess: true,
          httpStatus: 200,
          connectDurationMs: 120,
          tlsDurationMs: 80,
          totalDurationMs: 260,
          redirectCount: 0,
          finalOrigin: "https://www.service.example",
        },
      },
    },
    {
      fqdn: "app.pages.example",
      siteGroup: "pages.example",
      bucket: "candidate",
      reviewState: "active",
      status: "confirmed",
      selectedScope: "exact",
      proposedRule: "app.pages.example",
      eligibleScopes: ["exact"],
      scopeValid: true,
      siteUnavailableReason: "non-widenable-suffix",
      exclusionReason: null,
      policyExclusionReason: null,
      firstSeenAt: now - 12 * 60 * 60 * 1_000,
      lastSeenAt: now,
      lastValidationAt: now,
      nextValidationAt: now + 60_000,
      connectionCount: 12,
      evidenceAvailable: true,
      evidenceIntegrityIssue: null,
      decision: confirmedDecision,
      latestAttempts: { direct: null, proxy: null },
    },
  ],
};

const emptyExclusions: DomainCandidateList = { items: [], nextCursor: null };
const candidateFixture = candidates.items.at(0);
if (!candidateFixture) throw new Error("candidate fixture is missing");

const exclusions: DomainCandidateList = {
  nextCursor: null,
  items: [
    {
      ...candidateFixture,
      fqdn: "rejected.service.example",
      bucket: "exclusion",
      reviewState: "rejected",
      exclusionReason: "user-rejected",
      nextValidationAt: null,
    },
    {
      ...candidateFixture,
      fqdn: "edge.shared.example",
      bucket: "exclusion",
      status: "blocked",
      exclusionReason: "proxy-unstable",
    },
    {
      ...candidateFixture,
      fqdn: "static.notblocked.example",
      bucket: "exclusion",
      status: "blocked",
      exclusionReason: "already-covered",
    },
    {
      ...candidateFixture,
      fqdn: "telemetry.client.example",
      bucket: "exclusion",
      status: "excluded",
      selectedScope: null,
      proposedRule: null,
      eligibleScopes: [],
      scopeValid: false,
      siteUnavailableReason: "policy-excluded",
      exclusionReason: "telemetry-pattern",
      policyExclusionReason: "telemetry-pattern",
      nextValidationAt: null,
      evidenceAvailable: false,
      evidenceIntegrityIssue: null,
      decision: null,
      latestAttempts: { direct: null, proxy: null },
    },
  ],
};

function queryState<T>(data: T) {
  return { data, isLoading: false, isError: false, isFetching: false, refetch: vi.fn() };
}

function arrange(view = settingsView(), exclusionItems = emptyExclusions) {
  mocks.queryStates = new Map<string, unknown>([
    ["settings", queryState(view)],
    ["overview", queryState(overview)],
    ["list:candidates", queryState(candidates)],
    ["list:exclusions", queryState(exclusionItems)],
  ]);
  mocks.mutationStates = new Map(
    ["settings", "scope", "rejected", "recheck", "apply"].map((kind) => [
      kind,
      { mutate: vi.fn(), isPending: false },
    ]),
  );
}

beforeEach(() => {
  mocks.queryStates = new Map();
  mocks.mutationStates = new Map();
  mocks.queryOptions.mockClear();
  mocks.listQueryOptions.mockClear();
  mocks.mutationOptions.mockClear();
  mocks.invalidateQueries.mockClear();
  mocks.setQueryData.mockReset();
  mocks.toast.error.mockReset();
  mocks.toast.info.mockReset();
  mocks.toast.success.mockReset();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("DomainIntelligenceScreen", () => {
  it("shows scoped candidates and keeps shared hosting exact-only", () => {
    arrange();
    render(<DomainIntelligenceScreen />);

    expect(screen.getByRole("heading", { name: "Автоправила" })).toBeInTheDocument();
    expect(screen.getByText("+.service.example")).toBeInTheDocument();
    expect(screen.getByText("сайт целиком")).toBeInTheDocument();
    expect(screen.getByText("app.pages.example", { selector: "code" })).toBeInTheDocument();
    expect(screen.getByText("только точный адрес")).toBeInTheDocument();
    expect(screen.getByText("только отчёт", { exact: true })).toBeInTheDocument();
    expect(screen.queryByText("report-only", { exact: true })).toBeNull();

    expect(screen.getAllByText(/Адрес входит в список «Не расширять»/u)).toHaveLength(2);
    expect(screen.queryByRole("button", { name: "Подробнее о app.pages.example" })).toBeNull();
  });

  it("keeps report-mode add actions visibly unavailable", () => {
    arrange();
    render(<DomainIntelligenceScreen />);

    const addButton = screen.getByRole("button", { name: "Добавить www.service.example" });
    expect(addButton).toHaveAttribute("aria-disabled", "true");
    expect(addButton).not.toBeDisabled();
    addButton?.focus();
    expect(addButton).toHaveFocus();
    expect(addButton).toHaveAccessibleDescription(
      "Применение недоступно, пока сервер работает в режиме только отчёта",
    );
    fireEvent.click(addButton as HTMLElement);
    expect(mocks.toast.info).toHaveBeenCalledWith(
      "Применение недоступно, пока сервер работает в режиме только отчёта",
    );
  });

  it("fails closed when an older server response has no deployment capability", () => {
    const legacyView: Partial<DomainIntelligenceSettingsView> = settingsView();
    delete legacyView.deployment;
    Object.assign(legacyView, {
      automatic: { available: false, reason: "publisher-unavailable" },
    });
    arrange(legacyView as DomainIntelligenceSettingsView);

    expect(() => render(<DomainIntelligenceScreen />)).not.toThrow();
    expect(screen.getByText("только отчёт", { exact: true })).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Добавить www.service.example" }),
    ).toHaveAccessibleDescription(
      "Применение недоступно, пока сервер работает в режиме только отчёта",
    );
  });

  it("shows an error instead of masking a malformed current deployment capability", () => {
    arrange({
      ...settingsView(),
      deployment: null,
    } as unknown as DomainIntelligenceSettingsView);

    render(<DomainIntelligenceScreen />);

    expect(screen.getByText("Не удалось загрузить карту доменов")).toBeInTheDocument();
    expect(screen.queryByText("только отчёт", { exact: true })).toBeNull();
  });

  it("shows the actual apply provisioning blocker instead of report-only copy", () => {
    arrange(
      settingsView({
        deployment: {
          mode: "apply",
          apply: { available: false, reason: "local-store-unavailable" },
        },
      }),
    );
    render(<DomainIntelligenceScreen />);

    expect(screen.getByText("Локальное хранилище правил ещё не подготовлено.")).toBeInTheDocument();
    expect(screen.queryByText("только отчёт", { exact: true })).toBeNull();
    expect(
      screen.getByRole("button", { name: "Добавить www.service.example" }),
    ).toHaveAccessibleDescription(
      "Применение недоступно: локальное хранилище правил не подготовлено",
    );
  });

  it("submits a confirmed candidate when deployment apply is ready", async () => {
    arrange(
      settingsView({
        deployment: {
          mode: "apply",
          apply: {
            available: true,
            repository: "local",
            branch: "main",
            path: "custom.txt",
            providerName: "submerge-custom",
            providerPath: "./domain-rules/custom.txt",
          },
        },
      }),
    );
    render(<DomainIntelligenceScreen />);

    expect(screen.getByText("Локальный список готов к применению.")).toBeInTheDocument();
    const addButton = screen.getByRole("button", { name: "Добавить www.service.example" });
    expect(addButton).toBeEnabled();
    expect(addButton).not.toHaveAttribute("aria-disabled");
    fireEvent.click(addButton as HTMLElement);
    expect(mocks.mutationStates.get("apply")?.mutate).toHaveBeenCalledWith({
      fqdn: "www.service.example",
      operationId: expect.stringMatching(/^manual-add-[a-f0-9-]+$/u),
    });

    await act(async () => {
      await mocks.mutationStates.get("apply")?.callbacks?.onSuccess?.({
        operationId: "manual-add-review-1",
        phase: "completed",
        commitSha: "a".repeat(40),
        activationAttempt: 1,
      });
    });
    expect(mocks.toast.success).toHaveBeenCalledWith("Правило добавлено и активировано");
    expect(mocks.invalidateQueries).toHaveBeenCalled();
  });

  it("creates an idempotency key when randomUUID is unavailable on plain HTTP", () => {
    vi.stubGlobal("crypto", {});
    arrange(
      settingsView({
        deployment: {
          mode: "apply",
          apply: {
            available: true,
            repository: "local",
            branch: "main",
            path: "custom.txt",
            providerName: "submerge-custom",
            providerPath: "./domain-rules/custom.txt",
          },
        },
      }),
    );
    render(<DomainIntelligenceScreen />);

    fireEvent.click(screen.getByRole("button", { name: "Добавить www.service.example" }));
    expect(mocks.mutationStates.get("apply")?.mutate).toHaveBeenCalledWith({
      fqdn: "www.service.example",
      operationId: expect.stringMatching(/^manual-add-[a-z0-9]+-[a-z0-9]+$/u),
    });
  });

  it("does not offer apply outside manual-review mode even when deployment is ready", () => {
    arrange(
      settingsView({
        settings: {
          ...DEFAULT_DOMAIN_INTELLIGENCE_REPORT_SETTINGS,
          defaultRuleScope: "site",
        },
        deployment: {
          mode: "apply",
          apply: {
            available: true,
            repository: "local",
            branch: "main",
            path: "custom.txt",
            providerName: "submerge-custom",
            providerPath: "./domain-rules/custom.txt",
          },
        },
      }),
    );
    render(<DomainIntelligenceScreen />);

    expect(
      screen.getByRole("button", { name: "Добавить www.service.example" }),
    ).toHaveAccessibleDescription("Добавление доступно в режиме «Подтверждать вручную»");
  });

  it("reports durable deferred apply as queued instead of a terminal failure", async () => {
    arrange();
    render(<DomainIntelligenceScreen />);

    await act(async () => {
      await mocks.mutationStates.get("apply")?.callbacks?.onSuccess?.({
        operationId: "manual-add-review-1",
        phase: "queued",
        commitSha: null,
        activationAttempt: 0,
      });
    });

    expect(mocks.toast.info).toHaveBeenCalledWith(
      "Правило принято. Применение продолжится после восстановления",
    );
    expect(mocks.toast.error).not.toHaveBeenCalled();
  });

  it("keeps a queued candidate locked against a second operation id", async () => {
    arrange(
      settingsView({
        deployment: {
          mode: "apply",
          apply: {
            available: true,
            repository: "local",
            branch: "main",
            path: "custom.txt",
            providerName: "submerge-custom",
            providerPath: "./domain-rules/custom.txt",
          },
        },
      }),
    );
    render(<DomainIntelligenceScreen />);

    fireEvent.click(screen.getByRole("button", { name: "Добавить www.service.example" }));
    const apply = mocks.mutationStates.get("apply");
    expect(apply?.mutate).toHaveBeenCalledTimes(1);
    await act(async () => {
      await apply?.callbacks?.onSettled?.(
        {
          operationId: "manual-add-review-1",
          phase: "queued",
          commitSha: null,
          activationAttempt: 0,
        },
        null,
        { fqdn: "www.service.example" },
      );
    });

    const queued = screen.getByRole("button", { name: "Добавляется www.service.example" });
    expect(queued).toHaveAttribute("aria-busy", "true");
    fireEvent.click(queued);
    expect(apply?.mutate).toHaveBeenCalledTimes(1);
  });

  it("settles concurrent apply progress independently in reverse order", async () => {
    arrange(
      settingsView({
        deployment: {
          mode: "apply",
          apply: {
            available: true,
            repository: "local",
            branch: "main",
            path: "custom.txt",
            providerName: "submerge-custom",
            providerPath: "./domain-rules/custom.txt",
          },
        },
      }),
    );
    render(<DomainIntelligenceScreen />);

    fireEvent.click(screen.getByRole("button", { name: "Добавить www.service.example" }));
    fireEvent.click(screen.getByRole("button", { name: "Добавить app.pages.example" }));

    expect(screen.getByRole("button", { name: "Добавляется www.service.example" })).toHaveAttribute(
      "aria-busy",
      "true",
    );
    expect(screen.getByRole("button", { name: "Добавляется app.pages.example" })).toHaveAttribute(
      "aria-busy",
      "true",
    );
    expect(screen.getAllByText("В работе…", { exact: true })).toHaveLength(2);
    expect(screen.getByText("Правило для www.service.example добавляется")).toHaveAttribute(
      "aria-live",
      "polite",
    );

    await act(async () => {
      await mocks.mutationStates
        .get("apply")
        ?.callbacks?.onSettled?.(undefined, null, { fqdn: "app.pages.example" });
    });
    expect(screen.getByRole("button", { name: "Добавляется www.service.example" })).toHaveAttribute(
      "aria-busy",
      "true",
    );
    expect(screen.getByRole("button", { name: "Добавить app.pages.example" })).not.toHaveAttribute(
      "aria-busy",
    );

    await act(async () => {
      await mocks.mutationStates
        .get("apply")
        ?.callbacks?.onSettled?.(undefined, null, { fqdn: "www.service.example" });
    });
    expect(screen.queryByText("В работе…", { exact: true })).toBeNull();
  });

  it("separates a pending check from the unavailable add action", () => {
    const candidate = candidates.items[0];
    if (!candidate) throw new Error("candidate fixture is missing");
    arrange();
    mocks.queryStates.set(
      "list:candidates",
      queryState({
        items: [{ ...candidate, status: "pending" }],
        nextCursor: null,
      } satisfies DomainCandidateList),
    );
    render(<DomainIntelligenceScreen />);

    expect(screen.getByRole("status", { name: "Проверяется" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Проверяется" })).toBeNull();
    expect(screen.queryByRole("button", { name: /^Добавить /u })).toBeNull();
    const details = screen.getByRole("button", {
      name: "Открыть детали www.service.example",
    });
    expect(screen.getByText("Подробнее", { exact: true })).toBeInTheDocument();
    fireEvent.click(details);
    expect(
      screen.getByRole("button", { name: "Скрыть детали www.service.example" }),
    ).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByText("Скрыть", { exact: true })).toBeInTheDocument();
  });

  it("uses review mutations for scope and rejection without pretending to apply", () => {
    arrange();
    render(<DomainIntelligenceScreen />);

    fireEvent.click(screen.getByRole("button", { name: "Подробнее о www.service.example" }));
    expect(document.querySelectorAll(".domain-candidate-detail-row")).toHaveLength(4);
    expect(screen.getByRole("button", { name: "+.service.example" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Проверить сейчас" })).toHaveClass(
      "shrink-0",
      "whitespace-nowrap",
    );
    fireEvent.click(screen.getByRole("button", { name: "www.service.example" }));
    expect(mocks.mutationStates.get("scope")?.mutate).toHaveBeenCalledWith({
      fqdn: "www.service.example",
      selectedScope: "exact",
    });

    fireEvent.click(screen.getByRole("button", { name: "Не добавлять www.service.example" }));
    expect(mocks.mutationStates.get("rejected")?.mutate).toHaveBeenCalledWith({
      fqdn: "www.service.example",
      rejected: true,
    });
    expect(screen.getByRole("button", { name: "Добавить www.service.example" })).toHaveAttribute(
      "aria-disabled",
      "true",
    );
  });

  it("requires an explicit first-install scope before observation can start", () => {
    const unconfigured = settingsView({
      configurationState: "unconfigured",
      settings: DEFAULT_DOMAIN_INTELLIGENCE_REPORT_SETTINGS,
    });
    arrange(unconfigured);
    render(<DomainIntelligenceScreen />);

    expect(screen.getByText("Сначала выберите область правила")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Включить наблюдение" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Сайт целиком" }));
    expect(screen.getByRole("button", { name: "Включить наблюдение" })).toBeEnabled();
    fireEvent.click(screen.getByRole("button", { name: "Включить наблюдение" }));

    expect(mocks.mutationStates.get("settings")?.mutate).toHaveBeenCalledWith({
      ...DEFAULT_DOMAIN_INTELLIGENCE_REPORT_SETTINGS,
      enabled: true,
      defaultRuleScope: "site",
      automationMode: "review",
    });
  });

  it("opens exclusions as a separate panel view and restores focus on return", async () => {
    arrange(settingsView(), exclusions);
    render(<DomainIntelligenceScreen />);

    const exclusionsTrigger = document.querySelector<HTMLButtonElement>(
      ".domain-exclusions-trigger-header",
    );
    if (!exclusionsTrigger) throw new Error("exclusions trigger is missing");
    fireEvent.click(exclusionsTrigger);
    await waitFor(() => expect(screen.getByRole("button", { name: "К кандидатам" })).toHaveFocus());
    expect(screen.getByRole("link", { name: "Настроить фильтры" })).toHaveAttribute(
      "href",
      "/settings",
    );
    expect(screen.getByRole("button", { name: "Вернуть" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Проверить снова" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Показать правило" })).toHaveAttribute(
      "href",
      "/routing",
    );
    expect(screen.getByRole("link", { name: "Изменить фильтр" })).toHaveAttribute(
      "href",
      "/settings",
    );
    const exclusionsPanel = document.querySelector<HTMLElement>("#domain-exclusions");
    if (!exclusionsPanel) throw new Error("exclusions panel is missing");
    expect(within(exclusionsPanel).queryByText("только точный адрес")).toBeNull();
    expect(within(exclusionsPanel).queryByText("+.service.example")).toBeNull();
    expect(within(exclusionsPanel).getByText("Отклонён вами")).toBeInTheDocument();
    expect(within(exclusionsPanel).getByText("Не помогает VPN")).toBeInTheDocument();
    expect(within(exclusionsPanel).getByText("Уже покрыт")).toBeInTheDocument();
    expect(within(exclusionsPanel).getByText("Телеметрия")).toBeInTheDocument();
    expect(screen.queryByText("Ждут подтверждения")).toBeNull();

    const closeExclusions = screen.getByRole("button", { name: "К кандидатам" });
    closeExclusions.focus();
    fireEvent.click(closeExclusions);
    await waitFor(() => {
      expect(document.querySelector(".domain-exclusions-trigger-header")).toHaveFocus();
    });
    expect(screen.queryByRole("button", { name: "Вернуть" })).toBeNull();
    expect(screen.getByText("+.service.example")).toBeInTheDocument();
  });

  it("routes invalid policy exclusions to settings instead of a dead recheck", () => {
    const policyFixture = exclusions.items.at(-1);
    if (!policyFixture) throw new Error("policy exclusion fixture is missing");
    arrange(settingsView(), {
      items: [
        {
          ...policyFixture,
          fqdn: "invalid-policy.example",
          status: "blocked",
          selectedScope: null,
          proposedRule: null,
          eligibleScopes: [],
          scopeValid: false,
          siteUnavailableReason: "policy-unavailable",
          exclusionReason: "invalid-policy",
          policyExclusionReason: null,
        },
      ],
      nextCursor: null,
    });
    render(<DomainIntelligenceScreen />);

    const trigger = document.querySelector<HTMLButtonElement>(".domain-exclusions-trigger-header");
    if (!trigger) throw new Error("exclusions trigger is missing");
    fireEvent.click(trigger);
    expect(screen.getByText("Политика недоступна")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Изменить фильтр" })).toHaveAttribute(
      "href",
      "/settings",
    );
    expect(screen.queryByRole("button", { name: "Проверить снова" })).toBeNull();
  });

  it("keeps exclusion errors scoped and retries the exclusion query", () => {
    arrange();
    const refetch = vi.fn();
    mocks.queryStates.set("list:exclusions", {
      data: undefined,
      isLoading: false,
      isError: true,
      isFetching: false,
      refetch,
    });
    render(<DomainIntelligenceScreen />);

    const trigger = document.querySelector<HTMLButtonElement>(".domain-exclusions-trigger-header");
    if (!trigger) throw new Error("exclusions trigger is missing");
    fireEvent.click(trigger);
    const panel = document.querySelector<HTMLElement>("#domain-exclusions");
    if (!panel) throw new Error("exclusions panel is missing");
    expect(within(panel).getByText("Не удалось загрузить список доменов")).toBeInTheDocument();
    expect(screen.queryByText("Ждут подтверждения")).toBeNull();
    fireEvent.click(within(panel).getByRole("button", { name: "Повторить" }));
    expect(refetch).toHaveBeenCalledOnce();
  });

  it("paginates exclusions with the exclusion query cursor", () => {
    arrange();
    const fetchNextPage = vi.fn();
    mocks.queryStates.set("list:exclusions", {
      ...queryState({ ...exclusions, nextCursor: "edge.shared.example" }),
      fetchNextPage,
    });
    render(<DomainIntelligenceScreen />);

    const trigger = document.querySelector<HTMLButtonElement>(".domain-exclusions-trigger-header");
    if (!trigger) throw new Error("exclusions trigger is missing");
    fireEvent.click(trigger);
    const panel = document.querySelector<HTMLElement>("#domain-exclusions");
    if (!panel) throw new Error("exclusions panel is missing");
    fireEvent.click(within(panel).getByRole("button", { name: "Загрузить ещё" }));
    expect(fetchNextPage).toHaveBeenCalledOnce();
  });

  it("shows list failures instead of presenting them as an empty result", () => {
    arrange();
    mocks.queryStates.set("list:candidates", {
      data: undefined,
      isLoading: false,
      isError: true,
      isFetching: false,
      refetch: vi.fn(),
    });
    render(<DomainIntelligenceScreen />);

    expect(screen.getByText("Не удалось загрузить список доменов")).toBeInTheDocument();
    expect(screen.queryByText("Нечего подтверждать")).toBeNull();
  });

  it("surfaces fail-closed mutation results instead of reporting success", () => {
    arrange();
    render(<DomainIntelligenceScreen />);

    act(() => {
      mocks.mutationStates.get("settings")?.callbacks?.onSuccess?.({
        view: settingsView(),
        applied: false,
      });
    });
    expect(mocks.toast.error).toHaveBeenCalledWith(
      "Настройки сохранены, но Mihomo не подтвердил активацию",
    );

    act(() => {
      mocks.mutationStates.get("scope")?.callbacks?.onSuccess?.({
        ok: false,
        reason: "scope-unavailable",
      });
    });
    expect(mocks.toast.error).toHaveBeenCalledWith("Эта область больше недоступна");
  });

  it("does not call an enabled but inactive observer healthy", () => {
    arrange();
    mocks.queryStates.set(
      "overview",
      queryState({
        ...overview,
        health: { ...overview.health, status: "inactive", reason: "disabled" },
      } satisfies DomainIntelligenceOverview),
    );
    render(<DomainIntelligenceScreen />);

    expect(screen.getByText("Активация не подтверждена")).toBeInTheDocument();
    expect(screen.queryByText("Наблюдение активно")).toBeNull();
  });

  it("uses only the current UTC aggregate for today's count", () => {
    arrange();
    mocks.queryStates.set(
      "overview",
      queryState({
        ...overview,
        dailyAggregates: [{ day: "2026-08-03", connectionCount: 67, uniqueDomainCount: 18 }],
      } satisfies DomainIntelligenceOverview),
    );
    render(<DomainIntelligenceScreen />);

    expect(screen.getByText("0 доменов сегодня (UTC)")).toBeInTheDocument();
    expect(screen.queryByText("18 доменов за сутки")).toBeNull();
  });

  it("does not claim valid evidence when decision integrity is missing", () => {
    const candidate = candidates.items[0];
    if (!candidate) throw new Error("candidate fixture is missing");
    arrange();
    mocks.queryStates.set(
      "list:candidates",
      queryState({
        items: [
          {
            ...candidate,
            decision: null,
            evidenceAvailable: false,
            evidenceIntegrityIssue: "missing-decision",
          },
        ],
        nextCursor: null,
      } satisfies DomainCandidateList),
    );
    render(<DomainIntelligenceScreen />);

    expect(screen.getByText(/Доказательства недоступны/u)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Подробнее о www.service.example" }));
    expect(screen.queryByText("проверено, активными правилами не покрыт")).toBeNull();
  });

  it("colors probe evidence by actual transport result", () => {
    const candidate = candidates.items[0];
    if (!candidate) throw new Error("candidate fixture is missing");
    arrange();
    mocks.queryStates.set(
      "list:candidates",
      queryState({
        items: [
          {
            ...candidate,
            status: "pending",
            decision: null,
            evidenceAvailable: false,
            latestAttempts: {
              direct: {
                ...candidate.latestAttempts.direct,
                attemptedAt: now,
                category: "http_response",
                transportSuccess: true,
                httpStatus: 403,
                connectDurationMs: 40,
                tlsDurationMs: 30,
                totalDurationMs: 90,
                redirectCount: 0,
                finalOrigin: "https://www.service.example",
              },
              proxy: {
                ...candidate.latestAttempts.proxy,
                attemptedAt: now,
                category: "connect_timeout",
                transportSuccess: false,
                httpStatus: null,
                connectDurationMs: 8_000,
                tlsDurationMs: null,
                totalDurationMs: 8_000,
                redirectCount: 0,
                finalOrigin: "https://www.service.example",
              },
            },
          },
        ],
        nextCursor: null,
      } satisfies DomainCandidateList),
    );
    render(<DomainIntelligenceScreen />);
    fireEvent.click(screen.getByRole("button", { name: "Подробнее о www.service.example" }));

    expect(screen.getByText("DIRECT", { exact: true })).toHaveClass("text-online");
    expect(screen.getByText("PROXY", { exact: true })).toHaveClass("text-timeout");
  });

  it("offers pagination when the API returns a cursor", () => {
    arrange();
    mocks.queryStates.set(
      "list:candidates",
      queryState({ ...candidates, nextCursor: "www.service.example" }),
    );
    render(<DomainIntelligenceScreen />);

    expect(screen.getByRole("button", { name: "Загрузить ещё" })).toBeInTheDocument();
  });

  it("explains public-suffix exact scope without blaming the Never widen list", () => {
    const candidate = candidates.items[1];
    if (!candidate) throw new Error("candidate fixture is missing");
    arrange();
    mocks.queryStates.set(
      "list:candidates",
      queryState({
        items: [
          {
            ...candidate,
            fqdn: "service.co.uk",
            siteGroup: "co.uk",
            proposedRule: "service.co.uk",
            siteUnavailableReason: "public-suffix",
          },
        ],
        nextCursor: null,
      } satisfies DomainCandidateList),
    );
    render(<DomainIntelligenceScreen />);
    const compactSummary = document.querySelector<HTMLElement>(".domain-candidate-summary-compact");
    if (!compactSummary) throw new Error("compact candidate summary is missing");
    expect(within(compactSummary).getByText(/co\.uk — публичный суффикс/u)).toBeInTheDocument();
    expect(screen.queryByText(/co\.uk в списке «Не расширять»/u)).toBeNull();
  });

  it("does not claim that the derived site group is the configured Never widen suffix", () => {
    const candidate = candidates.items[1];
    if (!candidate) throw new Error("candidate fixture is missing");
    arrange();
    mocks.queryStates.set(
      "list:candidates",
      queryState({
        items: [
          {
            ...candidate,
            fqdn: "api.tenant.vercel.app",
            siteGroup: "tenant.vercel.app",
            proposedRule: "api.tenant.vercel.app",
          },
        ],
        nextCursor: null,
      } satisfies DomainCandidateList),
    );
    render(<DomainIntelligenceScreen />);
    const compactSummary = document.querySelector<HTMLElement>(".domain-candidate-summary-compact");
    if (!compactSummary) throw new Error("compact candidate summary is missing");
    expect(
      within(compactSummary).getByText(/Адрес входит в список «Не расширять»/u),
    ).toBeInTheDocument();
    expect(screen.queryByText(/tenant\.vercel\.app совпадает/u)).toBeNull();
    expect(screen.queryByText(/tenant\.vercel\.app в списке/u)).toBeNull();
  });
});
