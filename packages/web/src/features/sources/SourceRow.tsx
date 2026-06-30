import type { Source } from "@submerge/shared";
import { Inbox, Link, Lock, RotateCw, Trash2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";

interface SourceRowProps {
  source: Source;
  onToggle(): void;
  onRefresh(): void;
  onRemove(): void;
  busy?: boolean;
}

function KindIcon({ kind }: { kind: Source["kind"] }) {
  if (kind === "happ") return <Lock aria-hidden className="h-4 w-4 shrink-0 text-text-tertiary" />;
  if (kind === "vless") return <Link aria-hidden className="h-4 w-4 shrink-0 text-text-tertiary" />;
  return <Inbox aria-hidden className="h-4 w-4 shrink-0 text-text-tertiary" />;
}

export function SourceRow({ source, onToggle, onRefresh, onRemove, busy }: SourceRowProps) {
  const isBusy = busy === true;

  function handleRemove() {
    if (window.confirm("Удалить источник?")) {
      onRemove();
    }
  }

  return (
    <div className="flex items-center gap-3 border-b border-border-subtle px-4 py-3 last:border-0">
      <KindIcon kind={source.kind} />
      <span
        className={cn(
          "flex-1 truncate font-mono text-sm text-text-primary",
          !source.enabled && "opacity-60",
        )}
        title={source.value}
      >
        {source.label || source.value}
      </span>
      <Badge variant="neutral">{source.proxies.length} узл.</Badge>
      {source.hwid && <Badge variant="accent">HWID</Badge>}
      <Switch
        checked={source.enabled}
        onCheckedChange={onToggle}
        disabled={isBusy}
        aria-label="Включить источник"
      />
      <Button
        variant="ghost"
        size="icon"
        disabled={isBusy}
        onClick={onRefresh}
        aria-label="Обновить источник"
      >
        <RotateCw className="h-4 w-4" />
      </Button>
      <Button
        variant="ghost"
        size="icon"
        disabled={isBusy}
        onClick={handleRemove}
        aria-label="Удалить источник"
        className="hover:text-timeout"
      >
        <Trash2 className="h-4 w-4" />
      </Button>
    </div>
  );
}
