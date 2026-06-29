import { useLiveState } from "@/features/live/LiveProvider";

export function StatusDot() {
  const { mihomo } = useLiveState();
  const pending = mihomo === null;
  const dotClass = pending ? "bg-idle" : mihomo ? "bg-online" : "bg-timeout";
  const label = pending ? "проверка" : mihomo ? "online" : "offline";
  return (
    <div className="flex items-center gap-2 text-xs text-text-secondary">
      <span className={`h-2 w-2 rounded-full ${dotClass}`} />
      mihomo: {label}
    </div>
  );
}
