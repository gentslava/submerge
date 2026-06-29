import { createContext, type ReactNode, useContext } from "react";
import { type LiveState, useLive } from "./useLive";

const LiveContext = createContext<LiveState | null>(null);

export function LiveProvider({ children }: { children: ReactNode }) {
  const live = useLive();
  return <LiveContext value={live}>{children}</LiveContext>;
}

export function useLiveState(): LiveState {
  const ctx = useContext(LiveContext);
  if (!ctx) throw new Error("useLiveState must be used within a LiveProvider");
  return ctx;
}
