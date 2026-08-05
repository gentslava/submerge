import { render } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SettingsScreen } from "./SettingsScreen";

const mocks = vi.hoisted(() => ({
  callbacks: new Map<
    string,
    { onError?: (error: Error) => void; onSuccess?: (result: { applied: boolean }) => void }
  >(),
  invalidateQueries: vi.fn(),
  mutate: vi.fn(),
  toast: { error: vi.fn(), success: vi.fn(), warning: vi.fn() },
}));

vi.mock("@tanstack/react-query", () => ({
  useQuery: (options: { kind: string }) => {
    if (options.kind === "settings") {
      return {
        data: { hwid: "device-id", mihomoSecret: "old-secret", proxyEndpoint: "127.0.0.1:7890" },
        isError: false,
        isLoading: false,
        refetch: vi.fn(),
      };
    }
    if (options.kind === "health") {
      return {
        data: { connected: true },
        isFetching: false,
        isLoading: false,
        refetch: vi.fn(),
      };
    }
    if (options.kind === "nodes") return { data: { all: [], autoNow: null, now: null } };
    if (options.kind === "decisions") return { data: [] };
    return { data: undefined };
  },
  useMutation: (options: {
    callbacks: {
      onError?: (error: Error) => void;
      onSuccess?: (result: { applied: boolean }) => void;
    };
    kind: string;
  }) => {
    mocks.callbacks.set(options.kind, options.callbacks);
    return { isPending: false, mutate: mocks.mutate };
  },
  useQueryClient: () => ({ invalidateQueries: mocks.invalidateQueries }),
}));

vi.mock("sonner", () => ({ toast: mocks.toast }));
vi.mock("@/features/auth/useAuth", () => ({
  useAuthStatus: () => ({ data: { required: false } }),
  useLogout: () => ({ isPending: false, mutate: vi.fn() }),
}));
vi.mock("@/features/channels/PolicyEditor", () => ({ PolicyEditor: () => null }));
vi.mock("@/features/domain-intelligence/DomainIntelligenceSettingsSection", () => ({
  DomainIntelligenceSettingsSection: () => null,
}));
vi.mock("@/lib/theme-context", () => ({
  useTheme: () => ({ setTheme: vi.fn(), theme: "system" }),
}));
vi.mock("@/lib/trpc", () => ({
  useTRPC: () => ({
    channels: {
      get: { queryOptions: () => ({ kind: "channel" }) },
      recentDecisions: { queryOptions: () => ({ kind: "decisions" }) },
      setPolicy: {
        mutationOptions: (callbacks: unknown) => ({ callbacks, kind: "policy-set" }),
      },
    },
    nodes: {
      health: { queryOptions: () => ({ kind: "health" }) },
      list: { queryOptions: () => ({ kind: "nodes" }) },
    },
    settings: {
      get: { queryKey: () => ["settings"], queryOptions: () => ({ kind: "settings" }) },
      set: {
        mutationOptions: (callbacks: unknown) => ({ callbacks, kind: "settings-set" }),
      },
    },
  }),
}));

beforeEach(() => {
  mocks.callbacks.clear();
  mocks.invalidateQueries.mockReset();
  mocks.mutate.mockReset();
  mocks.toast.error.mockReset();
  mocks.toast.success.mockReset();
  mocks.toast.warning.mockReset();
});

describe("SettingsScreen mutation contract", () => {
  it("shows saved feedback only for a durable mutation response", () => {
    render(<SettingsScreen />);
    const callbacks = mocks.callbacks.get("settings-set");

    callbacks?.onError?.(new Error("Не удалось сохранить секрет mihomo"));
    expect(mocks.toast.error).toHaveBeenCalledWith("Не удалось сохранить секрет mihomo");
    expect(mocks.toast.success).not.toHaveBeenCalled();
    expect(mocks.toast.warning).not.toHaveBeenCalled();

    callbacks?.onSuccess?.({ applied: false });
    expect(mocks.toast.success).toHaveBeenCalledWith("Сохранено");
    expect(mocks.toast.warning).toHaveBeenCalledWith(
      "Сохранено, но движок недоступен — применится при следующем подключении",
    );
  });
});
