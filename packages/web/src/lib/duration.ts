// Human label for a check/poll interval given in seconds: whole minutes of 2+ minutes
// read as "N мин" (clearer than "300 с"); anything shorter stays in seconds ("30 с").
export function formatInterval(seconds: number): string {
  if (seconds >= 120 && seconds % 60 === 0) return `${seconds / 60} мин`;
  return `${seconds} с`;
}

// Compact clock label for a connection's age: `M:SS` under an hour, `H:MM:SS`
// beyond (matches the mockup's "1:12"). `now` is injectable for tests.
export function formatElapsed(startIso: string, now: number = Date.now()): string {
  const start = Date.parse(startIso);
  if (Number.isNaN(start)) return "—";
  let sec = Math.max(0, Math.floor((now - start) / 1000));
  const h = Math.floor(sec / 3600);
  sec -= h * 3600;
  const m = Math.floor(sec / 60);
  sec -= m * 60;
  const pad = (n: number) => String(n).padStart(2, "0");
  return h > 0 ? `${h}:${pad(m)}:${pad(sec)}` : `${m}:${pad(sec)}`;
}

// Coarse relative-time label for a controller decision timestamp ("2 ч назад",
// "только что"). `now` is injectable for deterministic unit tests; defaults to
// the current time in production.
export function formatRelative(epochMs: number, now: number = Date.now()): string {
  const diffSec = Math.max(0, Math.floor((now - epochMs) / 1000));
  if (diffSec < 60) return "только что";
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `${diffMin} мин назад`;
  const diffHours = Math.floor(diffMin / 60);
  if (diffHours < 24) return `${diffHours} ч назад`;
  const diffDays = Math.floor(diffHours / 24);
  return `${diffDays} дн назад`;
}
