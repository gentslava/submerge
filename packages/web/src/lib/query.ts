import { QueryClient } from "@tanstack/react-query";

export function makeQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        // node/source data needn't be fresher than this on idle tabs
        staleTime: 5_000,
        retry: 1,
      },
    },
  });
}
