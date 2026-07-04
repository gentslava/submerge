// Domain preset registry — the front/back contract for per-channel routing chips.
// Only `{id, label}` lives here; the curated domain lists themselves are a server
// concern (packages/server/src/modules/channels/presets.ts) since the web only
// needs to render chips, never the underlying domains.

export const CHANNEL_PRESETS = [
  { id: "youtube", label: "YouTube" },
  { id: "telegram", label: "Telegram" },
  { id: "discord", label: "Discord" },
  { id: "torrent", label: "Torrent" },
] as const;

export type PresetId = (typeof CHANNEL_PRESETS)[number]["id"];
