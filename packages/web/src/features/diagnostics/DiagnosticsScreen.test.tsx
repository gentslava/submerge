import type { DiagnosticsResult } from "@submerge/shared";
import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DiagnosticsScreen } from "./DiagnosticsScreen";

const result: DiagnosticsResult = {
  startedAt: "2026-07-16T06:00:00.000Z",
  completedAt: "2026-07-16T06:00:01.000Z",
  durationMs: 1_000,
  state: "ready",
  summary: "Проверено без ошибок",
  components: [
    {
      id: "submerge",
      status: "ok",
      durationMs: 1,
      version: "0.2.0",
      detail: "Доступен",
      errorCode: null,
    },
  ],
  externalIp: {
    status: "ok",
    ip: "185.107.56.42",
    country: "NL",
    colo: "AMS",
    durationMs: 84,
    route: "AUTO",
    node: "nl-ams-01",
    detail: "Определён",
    errorCode: null,
  },
  routes: [],
  services: [],
  config: {
    status: "ok",
    proxyEndpoint: "127.0.0.1:7890",
    mode: "rule",
    dns: true,
    ipv6: false,
    tun: false,
    errorCode: null,
  },
};

interface QueryState {
  data: DiagnosticsResult | undefined;
  isLoading: boolean;
  isFetching: boolean;
  isError: boolean;
  error: Error | undefined;
  refetch: ReturnType<typeof vi.fn>;
}

const mocks = vi.hoisted(() => ({
  query: {
    data: undefined,
    isLoading: true,
    isFetching: true,
    isError: false,
    error: undefined,
    refetch: vi.fn(),
  } as QueryState,
  queryOptions: vi.fn(),
  queryKey: ["diagnostics", "run", { force: false }] as const,
  forcedQuery: vi.fn(),
  setQueryData: vi.fn(),
  mutate: vi.fn(),
  mutationOptions: null as {
    mutationFn: () => Promise<DiagnosticsResult>;
    onSuccess: (value: DiagnosticsResult) => void;
  } | null,
  pending: false,
}));

vi.mock("@tanstack/react-query", () => ({
  useQuery: () => mocks.query,
  useQueryClient: () => ({ setQueryData: mocks.setQueryData }),
  useMutation: (options: typeof mocks.mutationOptions) => {
    mocks.mutationOptions = options;
    return { isPending: mocks.pending, mutate: mocks.mutate };
  },
}));

vi.mock("@/lib/trpc", () => ({
  useTRPC: () => ({
    diagnostics: {
      run: {
        queryOptions: mocks.queryOptions,
        queryKey: () => mocks.queryKey,
      },
    },
  }),
  useTRPCClient: () => ({ diagnostics: { run: { query: mocks.forcedQuery } } }),
}));

beforeEach(() => {
  mocks.query = {
    data: undefined,
    isLoading: true,
    isFetching: true,
    isError: false,
    error: undefined,
    refetch: vi.fn(),
  };
  mocks.pending = false;
  mocks.queryOptions.mockReset();
  mocks.forcedQuery.mockReset();
  mocks.setQueryData.mockReset();
  mocks.mutate.mockReset();
  mocks.mutationOptions = null;
});

describe("DiagnosticsScreen", () => {
  it("requests a fresh cached result on mount without polling", () => {
    render(<DiagnosticsScreen />);

    expect(mocks.queryOptions).toHaveBeenCalledWith(
      { force: false },
      expect.objectContaining({
        staleTime: 0,
        refetchOnMount: "always",
        retry: false,
      }),
    );
    expect(mocks.queryOptions.mock.calls[0]?.[1]).not.toHaveProperty("refetchInterval");
    expect(screen.getByText("Выполняем первичную проверку")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Проверить снова" })).toBeDisabled();
  });

  it("keeps the previous result visible during a forced refresh", () => {
    mocks.query = { ...mocks.query, data: result, isLoading: false, isFetching: false };
    mocks.pending = true;

    render(<DiagnosticsScreen />);

    expect(screen.getByText("185.107.56.42")).toBeInTheDocument();
    expect(screen.getByText("Проверка выполняется")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Проверить снова" })).toBeDisabled();
  });

  it("keeps the previous result visible during the mount refetch", () => {
    mocks.query = { ...mocks.query, data: result, isLoading: false, isFetching: true };

    render(<DiagnosticsScreen />);

    expect(screen.getByText("185.107.56.42")).toBeInTheDocument();
    expect(screen.getByText("Проверка выполняется")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Проверить снова" })).toBeDisabled();
  });

  it("runs a forced check and places the response in the regular query cache", async () => {
    mocks.query = { ...mocks.query, data: result, isLoading: false, isFetching: false };
    mocks.forcedQuery.mockResolvedValue(result);
    render(<DiagnosticsScreen />);

    fireEvent.click(screen.getByRole("button", { name: "Проверить снова" }));
    expect(mocks.mutate).toHaveBeenCalledTimes(1);

    const options = mocks.mutationOptions;
    if (!options) throw new Error("mutation options were not registered");
    await expect(options.mutationFn()).resolves.toEqual(result);
    expect(mocks.forcedQuery).toHaveBeenCalledWith({ force: true });
    options.onSuccess(result);
    expect(mocks.setQueryData).toHaveBeenCalledWith(mocks.queryKey, result);
  });

  it("shows a recoverable first-load error", () => {
    mocks.query = {
      ...mocks.query,
      isLoading: false,
      isFetching: false,
      isError: true,
      error: new Error("transport unavailable"),
    };
    render(<DiagnosticsScreen />);

    expect(screen.getByText("Не удалось запустить диагностику")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Повторить" }));
    expect(mocks.query.refetch).toHaveBeenCalledTimes(1);
  });
});
