import { Outlet } from "@tanstack/react-router";
import { BottomNav } from "./BottomNav";
import { Sidebar } from "./Sidebar";

export function AppShell() {
  return (
    <div className="flex h-dvh overflow-hidden bg-canvas text-text-primary">
      <a
        href="#main-content"
        className="fixed top-5 left-3.5 z-[60] flex min-h-11 -translate-y-[calc(100%+1.5rem)] items-center rounded-md border border-accent-border bg-surface px-3 text-sub font-semibold text-accent-text shadow-lg transition-transform focus:translate-y-0 focus:outline-none focus:ring-2 focus:ring-accent-border"
      >
        Перейти к содержимому
      </a>
      <Sidebar />
      <main
        id="main-content"
        tabIndex={-1}
        className="app-main relative min-h-0 flex-1 overscroll-y-none overflow-y-auto bg-canvas pb-[var(--mobile-bottom-nav-height)] focus:outline-none md:pb-0"
      >
        <Outlet />
      </main>
      <BottomNav />
    </div>
  );
}
