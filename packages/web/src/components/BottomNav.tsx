import { Link } from "@tanstack/react-router";
import { Activity, Inbox, Menu, Radio, Settings } from "lucide-react";

const linkClass =
  "flex h-14 flex-1 flex-col items-center justify-center gap-0.5 text-[10px] text-text-secondary [&.active]:text-accent-text";

export function BottomNav() {
  return (
    <nav className="md:hidden fixed bottom-0 inset-x-0 flex border-t border-border-subtle bg-surface">
      <Link to="/" activeOptions={{ exact: true }} className={linkClass}>
        <Activity size={18} />
        Узлы
      </Link>
      <Link to="/sources" className={linkClass}>
        <Inbox size={18} />
        Источники
      </Link>
      {/* Disabled placeholder */}
      <div className="flex h-14 flex-1 flex-col items-center justify-center gap-0.5 text-[10px] text-text-disabled cursor-not-allowed">
        <Radio size={18} />
        Трафик
      </div>
      <Link to="/settings" className={linkClass}>
        <Settings size={18} />
        Настройки
      </Link>
      <Link to="/more" className={linkClass}>
        <Menu size={18} />
        Ещё
      </Link>
    </nav>
  );
}
