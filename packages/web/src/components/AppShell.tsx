import { Outlet } from "@tanstack/react-router";
import { BottomNav } from "./BottomNav";
import { Sidebar } from "./Sidebar";

export function AppShell() {
  return (
    <div className="flex h-dvh overflow-hidden bg-canvas text-text-primary">
      <Sidebar />
      <main className="app-main relative min-h-0 flex-1 overscroll-y-none overflow-y-auto bg-canvas pb-[var(--mobile-bottom-nav-height)] md:pb-0">
        <Outlet />
      </main>
      <BottomNav />
    </div>
  );
}
