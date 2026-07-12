import { Link } from "@tanstack/react-router";
import { ChevronRight, Power, RotateCw } from "lucide-react";
import { NAV_MOBILE_MORE } from "@/components/nav";
import { ProxyStatusCard } from "@/components/ProxyStatusCard";
import { useAuthStatus, useLogout } from "@/features/auth/useAuth";
import { useReloadCore } from "@/features/settings/useReloadCore";

export function MoreRoute() {
  const reload = useReloadCore();
  const authStatus = useAuthStatus();
  const logout = useLogout();

  return (
    <div className="responsive-page responsive-page--more page-content page-content--more mx-auto flex max-w-4xl flex-col gap-4 px-4 pt-5 pb-8">
      <header className="flex flex-col gap-0.5">
        <h1 className="text-h1 text-text-primary">Ещё</h1>
        <p className="text-sub text-text-secondary">Остальные разделы и управление сервером</p>
      </header>

      <section className="flex flex-col gap-2">
        <h2 className="text-caption text-text-tertiary">РАЗДЕЛЫ</h2>
        <div className="flex flex-col rounded-xl border border-border-subtle bg-surface">
          {NAV_MOBILE_MORE.map((entry) => {
            const { label, icon: Icon } = entry;
            if (entry.kind === "placeholder") {
              return (
                <div
                  key={label}
                  className="flex items-center gap-3 border-b border-border-subtle px-3.5 py-3.5 text-text-disabled last:border-0"
                >
                  <Icon size={20} />
                  <span className="flex-1 text-label">{label}</span>
                  <span className="rounded-full bg-hover px-2 py-0.5 text-fine font-semibold text-text-tertiary">
                    скоро
                  </span>
                </div>
              );
            }
            return (
              <Link
                key={entry.to}
                to={entry.to}
                activeOptions={{ exact: false }}
                className="flex items-center gap-3 border-b border-border-subtle px-3.5 py-3.5 text-text-primary transition-colors last:border-0 hover:bg-hover"
              >
                <Icon size={20} className="text-text-secondary" />
                <span className="flex-1 text-label">{label}</span>
                <ChevronRight size={18} className="text-text-tertiary" />
              </Link>
            );
          })}
        </div>
      </section>

      <section className="flex flex-col gap-2">
        <h2 className="text-caption text-text-tertiary">СЕРВЕР</h2>
        <div className="rounded-xl border border-border-subtle bg-surface">
          <button
            type="button"
            onClick={() => reload.mutate()}
            disabled={reload.isPending}
            className="flex w-full items-center gap-3 px-3.5 py-3.5 text-left text-text-primary transition-colors hover:bg-hover disabled:opacity-50"
          >
            <RotateCw
              size={20}
              className={
                reload.isPending ? "animate-spin text-text-secondary" : "text-text-secondary"
              }
            />
            <span className="flex flex-1 flex-col gap-0.5">
              <span className="text-label">Перезагрузить конфиг</span>
              <span className="text-xs text-text-tertiary">
                Отправить обновлённый конфиг в mihomo
              </span>
            </span>
            <ChevronRight size={18} className="text-text-tertiary" />
          </button>
        </div>
      </section>

      <ProxyStatusCard showReload={false} />

      {authStatus.data?.required && (
        <button
          type="button"
          onClick={() => logout.mutate()}
          disabled={logout.isPending}
          className="flex items-center gap-3 rounded-xl border border-border-subtle bg-surface px-3.5 py-3.5 text-text-tertiary transition-colors hover:bg-hover hover:text-text-secondary disabled:opacity-50"
        >
          <Power size={20} />
          <span className="text-label">Выйти</span>
        </button>
      )}
    </div>
  );
}
