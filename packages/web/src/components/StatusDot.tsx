import { useQuery } from "@tanstack/react-query";
import { useTRPC } from "@/lib/trpc";

export function StatusDot() {
  const trpc = useTRPC();
  const ping = useQuery({ ...trpc.health.ping.queryOptions(), refetchInterval: 10_000 });
  const pending = ping.data === undefined;
  const online = ping.data?.ok === true;
  const dotClass = pending ? "bg-idle" : online ? "bg-online" : "bg-timeout";
  const label = pending ? "проверка" : online ? "online" : "offline";
  // health.ping reports server liveness, not mihomo reachability — label it
  // honestly. A real mihomo status probe (via the client) lands in Phase 4.
  return (
    <div className="flex items-center gap-2 text-xs text-text-secondary">
      <span className={`h-2 w-2 rounded-full ${dotClass}`} />
      сервер: {label}
    </div>
  );
}
