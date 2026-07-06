// Domain preset registry — the front/back contract for per-channel routing chips.
// Only `{id, label, category}` lives here; the curated domain lists themselves are
// a server concern (packages/server/src/modules/channels/presets.ts) since the web
// only needs enough to render grouped chips, never the underlying domains.
// One preset = one resource (a single service, or — for `torrent` — the one
// established "pack of trackers" case). `category` groups presets in the UI only;
// it never affects domain resolution, which stays flat over every preset id.

// Fixed set of group captions — every preset's `category` below is checked against
// this via `satisfies`, so a typo (a new category not in this list, or a stray
// variant of an existing one) is a compile error instead of a silent phantom group
// in PresetChips.
const PRESET_CATEGORIES = [
  "Видео",
  "Мессенджеры",
  "AI",
  "Соцсети",
  "Стриминг",
  "Гейминг",
  "P2P",
] as const;
type PresetCategory = (typeof PRESET_CATEGORIES)[number];

export const CHANNEL_PRESETS = [
  { id: "youtube", label: "YouTube", category: "Видео" },
  { id: "telegram", label: "Telegram", category: "Мессенджеры" },
  { id: "whatsapp", label: "WhatsApp", category: "Мессенджеры" },
  { id: "signal", label: "Signal", category: "Мессенджеры" },
  { id: "viber", label: "Viber", category: "Мессенджеры" },
  { id: "discord", label: "Discord", category: "Мессенджеры" },
  { id: "openai", label: "OpenAI", category: "AI" },
  { id: "claude", label: "Claude", category: "AI" },
  { id: "gemini", label: "Gemini", category: "AI" },
  { id: "perplexity", label: "Perplexity", category: "AI" },
  { id: "grok", label: "Grok", category: "AI" },
  { id: "copilot", label: "Copilot", category: "AI" },
  { id: "midjourney", label: "Midjourney", category: "AI" },
  { id: "instagram", label: "Instagram", category: "Соцсети" },
  { id: "x", label: "X", category: "Соцсети" },
  { id: "facebook", label: "Facebook", category: "Соцсети" },
  { id: "tiktok", label: "TikTok", category: "Соцсети" },
  { id: "reddit", label: "Reddit", category: "Соцсети" },
  { id: "netflix", label: "Netflix", category: "Стриминг" },
  { id: "disneyplus", label: "Disney+", category: "Стриминг" },
  { id: "spotify", label: "Spotify", category: "Стриминг" },
  { id: "twitch", label: "Twitch", category: "Стриминг" },
  { id: "soundcloud", label: "SoundCloud", category: "Стриминг" },
  { id: "steam", label: "Steam", category: "Гейминг" },
  { id: "epicgames", label: "Epic Games", category: "Гейминг" },
  { id: "playstation", label: "PlayStation", category: "Гейминг" },
  { id: "xbox", label: "Xbox", category: "Гейминг" },
  { id: "battlenet", label: "Battle.net", category: "Гейминг" },
  { id: "riotgames", label: "Riot Games", category: "Гейминг" },
  { id: "torrent", label: "Torrent", category: "P2P" },
] as const satisfies readonly { id: string; label: string; category: PresetCategory }[];

export type PresetId = (typeof CHANNEL_PRESETS)[number]["id"];
