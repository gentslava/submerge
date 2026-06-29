import { useQuery } from "@tanstack/react-query";
import { useTRPC } from "@/lib/trpc";

export function StatusDot() {
  const trpc = useTRPC();
  const ping = useQuery({ ...trpc.health.ping.queryOptions(), refetchInterval: 10_000 });
  const online = ping.data?.ok === true;
  return (
    <div className="flex items-center gap-2 text-xs text-text-secondary">
      <span className={`h-2 w-2 rounded-full ${online ? "bg-online" : "bg-timeout"}`} />
      mihomo: {online ? "online" : "offline"}
    </div>
  );
}
