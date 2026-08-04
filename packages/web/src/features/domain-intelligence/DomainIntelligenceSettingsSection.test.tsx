import {
  DEFAULT_DOMAIN_INTELLIGENCE_REPORT_SETTINGS,
  type DomainIntelligenceSettingsView,
} from "@submerge/shared";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DomainIntelligenceSettingsSection } from "./DomainIntelligenceSettingsSection";

const view: DomainIntelligenceSettingsView = {
  configurationState: "ready",
  settings: {
    ...DEFAULT_DOMAIN_INTELLIGENCE_REPORT_SETTINGS,
    defaultRuleScope: "site",
    excludedTlds: ["local"],
    neverAddDomains: ["blocked.example"],
    neverAddSuffixes: ["telemetry.example"],
    nonWidenableSuffixes: ["vercel.app", "pages.example"],
  },
  automatic: { available: false, reason: "publisher-unavailable" },
};

const mocks = vi.hoisted(() => ({
  query: {
    data: undefined as DomainIntelligenceSettingsView | undefined,
    isLoading: false,
    isError: false,
    refetch: vi.fn(),
  },
  mutate: vi.fn(),
  pending: false,
  invalidateQueries: vi.fn(),
  setQueryData: vi.fn(),
  mutationOptions: vi.fn((options: unknown) => options),
  toast: { error: vi.fn(), success: vi.fn() },
}));

vi.mock("@tanstack/react-query", () => ({
  useQuery: () => mocks.query,
  useMutation: () => ({ mutate: mocks.mutate, isPending: mocks.pending }),
  useQueryClient: () => ({
    invalidateQueries: mocks.invalidateQueries,
    setQueryData: mocks.setQueryData,
  }),
}));

vi.mock("@/lib/trpc", () => ({
  useTRPC: () => ({
    domainIntelligence: {
      settings: { queryOptions: () => ({}), queryKey: () => ["domain-intelligence", "settings"] },
      overview: { queryKey: () => ["domain-intelligence", "overview"] },
      list: { infiniteQueryKey: () => ["domain-intelligence", "list", "infinite"] },
      setSettings: { mutationOptions: mocks.mutationOptions },
    },
  }),
}));

vi.mock("sonner", () => ({ toast: mocks.toast }));

beforeEach(() => {
  mocks.query = { data: view, isLoading: false, isError: false, refetch: vi.fn() };
  mocks.mutate.mockReset();
  mocks.pending = false;
  mocks.invalidateQueries.mockReset();
  mocks.setQueryData.mockReset();
  mocks.setQueryData.mockImplementation((_key, data: DomainIntelligenceSettingsView) => {
    mocks.query = { ...mocks.query, data };
  });
  mocks.mutationOptions.mockClear();
  mocks.toast.error.mockReset();
  mocks.toast.success.mockReset();
});

describe("DomainIntelligenceSettingsSection", () => {
  it("keeps Never add and Do not widen in independent editors", async () => {
    render(<DomainIntelligenceSettingsSection />);

    expect(screen.getByRole("spinbutton", { name: "Правил в сутки" })).toHaveAttribute("max", "3");

    fireEvent.click(screen.getByRole("button", { name: /Не добавлять/u }));
    expect(await screen.findByRole("heading", { name: "Не добавлять" })).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "Домены, которые не добавлять" })).toHaveValue(
      "blocked.example",
    );
    expect(screen.getByRole("textbox", { name: "Суффиксы, которые не добавлять" })).toHaveValue(
      "telemetry.example",
    );
    expect(
      screen.getByRole("textbox", { name: "Доменные зоны, которые не добавлять" }),
    ).toHaveValue("local");
    expect(screen.queryByRole("textbox", { name: "Суффиксы, которые не расширять" })).toBeNull();

    fireEvent.change(screen.getByRole("textbox", { name: "Суффиксы, которые не добавлять" }), {
      target: { value: "telemetry.example\nads.example" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Сохранить «Не добавлять»" }));
    expect(mocks.mutate).toHaveBeenCalledWith({
      ...view.settings,
      neverAddSuffixes: ["ads.example", "telemetry.example"],
    });

    fireEvent.click(screen.getByRole("button", { name: "Закрыть редактор «Не добавлять»" }));
    fireEvent.click(screen.getByRole("button", { name: /Не расширять/u }));
    expect(await screen.findByRole("dialog", { name: "Не расширять" })).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "Суффиксы, которые не расширять" })).toHaveValue(
      "pages.example\nvercel.app",
    );
  });

  it("persists the explicit initial scope independently of enabling observation", () => {
    mocks.query = {
      ...mocks.query,
      data: {
        configurationState: "unconfigured",
        settings: DEFAULT_DOMAIN_INTELLIGENCE_REPORT_SETTINGS,
        automatic: { available: false, reason: "publisher-unavailable" },
      },
    };
    render(<DomainIntelligenceSettingsSection />);

    fireEvent.click(screen.getByRole("button", { name: "Только адрес" }));
    expect(mocks.mutate).toHaveBeenCalledWith({
      ...DEFAULT_DOMAIN_INTELLIGENCE_REPORT_SETTINGS,
      defaultRuleScope: "exact",
    });
  });

  it("keeps repair controls available for a fail-closed invalid configuration", () => {
    mocks.query = {
      ...mocks.query,
      data: {
        configurationState: "invalid",
        settings: DEFAULT_DOMAIN_INTELLIGENCE_REPORT_SETTINGS,
        automatic: { available: false, reason: "publisher-unavailable" },
      },
    };
    render(<DomainIntelligenceSettingsSection />);

    const exact = screen.getByRole("button", { name: "Только адрес" });
    expect(exact).toBeEnabled();
    fireEvent.click(exact);
    expect(mocks.mutate).toHaveBeenCalledWith({
      ...DEFAULT_DOMAIN_INTELLIGENCE_REPORT_SETTINGS,
      defaultRuleScope: "exact",
    });
  });

  it("reports an unverified runtime activation and invalidates the full read model", () => {
    render(<DomainIntelligenceSettingsSection />);
    const callbacks = mocks.mutationOptions.mock.calls[0]?.[0] as
      | { onSuccess?: (result: unknown) => void }
      | undefined;
    callbacks?.onSuccess?.({ view, applied: false });

    expect(mocks.toast.error).toHaveBeenCalledWith(
      "Настройки сохранены, но Mihomo не подтвердил активацию",
    );
    expect(mocks.invalidateQueries).toHaveBeenCalledTimes(3);
  });

  it("bases a second full-object mutation on the first mutation result", async () => {
    const { rerender } = render(<DomainIntelligenceSettingsSection />);
    const callbacks = mocks.mutationOptions.mock.calls[0]?.[0] as
      | { onSuccess?: (result: unknown) => void | Promise<void> }
      | undefined;
    await act(async () => {
      await callbacks?.onSuccess?.({
        view: {
          ...view,
          settings: { ...view.settings, maximumAutomaticRulesPerDay: 2 },
        },
        applied: true,
      });
    });
    rerender(<DomainIntelligenceSettingsSection />);

    fireEvent.change(screen.getByRole("spinbutton", { name: "Неудачных попыток напрямую" }), {
      target: { value: "4" },
    });
    fireEvent.blur(screen.getByRole("spinbutton", { name: "Неудачных попыток напрямую" }));
    expect(mocks.mutate).toHaveBeenLastCalledWith({
      ...view.settings,
      maximumAutomaticRulesPerDay: 2,
      directAttemptsRequired: 4,
    });
  });
});
