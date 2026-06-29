import { Outlet } from "@tanstack/react-router";
import { BottomNav } from "./BottomNav";
import { Sidebar } from "./Sidebar";

export function AppShell() {
  return (
    <div className="flex min-h-dvh bg-canvas text-text-primary">
      <Sidebar />
      <main className="flex-1 pb-16 md:pb-0">
        <Outlet />
      </main>
      <BottomNav />
    </div>
  );
}
