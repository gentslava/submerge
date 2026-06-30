// Human label for a check/poll interval given in seconds: whole minutes of 2+ minutes
// read as "N мин" (clearer than "300 с"); anything shorter stays in seconds ("30 с").
export function formatInterval(seconds: number): string {
  if (seconds >= 120 && seconds % 60 === 0) return `${seconds / 60} мин`;
  return `${seconds} с`;
}
