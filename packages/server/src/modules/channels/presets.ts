// Curated domain lists behind each channel preset id, plus expansion of a
// channel's matcher (custom domains + selected presets) into the flat domain
// list `buildMultiConfig` turns into DOMAIN-SUFFIX rules. The lists themselves
// are server-only — the web only needs @submerge/shared's CHANNEL_PRESETS
// (id + label + category) to render grouped preset chips.
import { CHANNEL_PRESETS, type ChannelMatcher, type PresetId } from "@submerge/shared";

export const PRESET_DOMAINS: Record<PresetId, string[]> = {
  youtube: [
    "youtube.com",
    "googlevideo.com",
    "ytimg.com",
    "youtu.be",
    "youtubei.googleapis.com",
    "ggpht.com",
  ],
  telegram: ["telegram.org", "t.me", "telegram.me", "tdesktop.com", "telesco.pe", "telegra.ph"],
  discord: [
    "discord.com",
    "discord.gg",
    "discordapp.com",
    "discordapp.net",
    "discord.media",
    "discordcdn.com",
  ],
  torrent: [
    "rutracker.org",
    "nnmclub.to",
    "rutor.info",
    "1337x.to",
    "thepiratebay.org",
    "torrentgalaxy.to",
  ],
  whatsapp: ["whatsapp.com", "whatsapp.net"],
  signal: ["signal.org"],
  viber: ["viber.com"],
  openai: ["openai.com", "chatgpt.com", "oaistatic.com", "oaiusercontent.com"],
  claude: ["anthropic.com", "claude.ai"],
  gemini: ["gemini.google.com", "bard.google.com"],
  perplexity: ["perplexity.ai"],
  grok: ["x.ai", "grok.com"],
  copilot: ["githubcopilot.com", "copilot.microsoft.com"],
  cursor: ["cursor.com", "cursor.sh", "cursorapi.com", "cursor-cdn.com"],
  deepseek: ["deepseek.com"],
  mistral: ["mistral.ai"],
  huggingface: ["huggingface.co", "hf.co"],
  midjourney: ["midjourney.com"],
  instagram: ["instagram.com", "cdninstagram.com"],
  x: ["x.com", "twitter.com", "twimg.com"],
  facebook: ["facebook.com", "fbcdn.net"],
  tiktok: ["tiktok.com", "tiktokcdn.com", "ttwstatic.com"],
  reddit: ["reddit.com", "redditstatic.com", "redd.it"],
  netflix: ["netflix.com", "nflxvideo.net", "nflximg.net", "nflxext.com"],
  disneyplus: ["disneyplus.com", "disney-plus.net", "dssott.com"],
  spotify: ["spotify.com", "scdn.co"],
  twitch: ["twitch.tv", "ttvnw.net", "jtvnw.net"],
  soundcloud: ["soundcloud.com", "sndcdn.com"],
  steam: ["steampowered.com", "steamcommunity.com", "steamstatic.com", "steamcontent.com"],
  epicgames: ["epicgames.com", "unrealengine.com"],
  playstation: ["playstation.com", "playstation.net", "sonyentertainmentnetwork.com"],
  xbox: ["xbox.com", "xboxlive.com"],
  battlenet: ["battle.net", "blizzard.com"],
  riotgames: ["riotgames.com", "leagueoflegends.com", "playvalorant.com", "riotcdn.net"],
};

// Union of a matcher's custom domains (first, in their given order) and every
// selected preset's domains (in CHANNEL_PRESETS order, not matcher.presets order
// — a stable, UI-independent output). Duplicates are dropped, keeping the first
// occurrence. Iterating CHANNEL_PRESETS (rather than matcher.presets) means an
// unknown/stale preset id on a channel is silently skipped — it just never
// matches — so it can never break config generation.
export function resolveMatcherDomains(matcher: ChannelMatcher): string[] {
  const selected = new Set(matcher.presets);
  const domains: string[] = [...matcher.domains];
  for (const preset of CHANNEL_PRESETS) {
    if (selected.has(preset.id)) domains.push(...PRESET_DOMAINS[preset.id]);
  }
  const seen = new Set<string>();
  const result: string[] = [];
  for (const domain of domains) {
    if (seen.has(domain)) continue;
    seen.add(domain);
    result.push(domain);
  }
  return result;
}
