import { useLiveState } from "@/features/live/LiveProvider";

export function StatusDot() {
  const { mihomo } = useLiveState();
  const dotClass = mihomo ? "bg-online" : "bg-timeout";
  return (
    <div className="flex items-center gap-2 text-xs text-text-secondary">
      <span className={`h-2 w-2 rounded-full ${dotClass}`} />
      mihomo: {mihomo ? "online" : "offline"}
    </div>
  );
}
