import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { useTRPC } from "@/lib/trpc";

export function useAuthStatus() {
  const trpc = useTRPC();
  return useQuery(trpc.auth.me.queryOptions());
}

export function useLogout() {
  const trpc = useTRPC();
  const qc = useQueryClient();
  return useMutation(
    trpc.auth.logout.mutationOptions({
      onSuccess: () => {
        void qc.invalidateQueries(); // drop cached data; auth.me re-fetches → unauthed → LoginScreen
        toast.success("Вы вышли");
      },
      onError: (e) => toast.error(e.message),
    }),
  );
}
