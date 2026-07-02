// Tri-state connection indicator shared by the sidebar's ProxyCard, the nodes
// screen's AutoStrategyCard and Settings' engine row: null = still checking,
// true = engine reachable, false = down. Single source for the dot classes so
// the health color scheme can't drift between screens.
export interface LiveIndicator {
  dot: string;
  label: string;
}

export function liveIndicator(
  state: boolean | null,
  labels: { idle: string; ok: string; down: string },
): LiveIndicator {
  if (state === null) return { dot: "bg-idle", label: labels.idle };
  return state ? { dot: "bg-online", label: labels.ok } : { dot: "bg-timeout", label: labels.down };
}
