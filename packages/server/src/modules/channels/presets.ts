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
    "youtube-nocookie.com",
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
  openai: [
    "openai.com",
    "chatgpt.com",
    "oaistatic.com",
    "oaiusercontent.com",
    "sora.com",
    "openai.fm",
  ],
  claude: ["anthropic.com", "claude.ai", "claudeusercontent.com"],
  gemini: [
    "gemini.google.com",
    "bard.google.com",
    "aistudio.google.com",
    "makersuite.google.com",
    "generativelanguage.googleapis.com",
  ],
  perplexity: ["perplexity.ai"],
  grok: ["x.ai", "grok.com"],
  copilot: ["githubcopilot.com", "copilot.microsoft.com"],
  cursor: ["cursor.com", "cursor.sh", "cursorapi.com", "cursor-cdn.com"],
  deepseek: ["deepseek.com"],
  mistral: ["mistral.ai"],
  huggingface: ["huggingface.co", "hf.co"],
  suno: ["suno.com", "suno.ai"],
  elevenlabs: ["elevenlabs.io"],
  runway: ["runwayml.com"],
  ideogram: ["ideogram.ai"],
  characterai: ["character.ai"],
  poe: ["poe.com"],
  leonardo: ["leonardo.ai"],
  midjourney: ["midjourney.com"],
  github: ["github.com", "githubusercontent.com", "githubassets.com", "github.io", "ghcr.io"],
  gitlab: ["gitlab.com", "gitlab.io"],
  npm: ["npmjs.com", "npmjs.org"],
  pypi: ["pypi.org", "pythonhosted.org"],
  dockerhub: ["docker.com", "docker.io"],
  stackoverflow: ["stackoverflow.com", "stackexchange.com", "sstatic.net"],
  jetbrains: ["jetbrains.com"],
  vercel: ["vercel.com", "vercel.app"],
  netlify: ["netlify.com", "netlify.app"],
  replit: ["replit.com", "repl.co"],
  microsoft365: [
    "office.com",
    "office365.com",
    "microsoft365.com",
    "sharepoint.com",
    "onedrive.com",
    "outlook.com",
  ],
  googledrive: ["drive.google.com", "docs.google.com", "sheets.google.com", "slides.google.com"],
  notion: ["notion.so", "notion.com", "notion.site"],
  figma: ["figma.com"],
  dropbox: ["dropbox.com", "dropboxusercontent.com"],
  zoom: ["zoom.us", "zoom.com"],
  atlassian: ["atlassian.com", "atlassian.net"],
  slack: ["slack.com", "slack-edge.com"],
  line: ["line.me", "line-scdn.net"],
  wechat: ["wechat.com", "weixin.qq.com", "wx.qq.com"],
  element: ["element.io", "matrix.org"],
  threema: ["threema.ch"],
  instagram: ["instagram.com", "cdninstagram.com"],
  x: ["x.com", "twitter.com", "twimg.com"],
  facebook: ["facebook.com", "fbcdn.net"],
  tiktok: ["tiktok.com", "tiktokcdn.com", "ttwstatic.com"],
  reddit: ["reddit.com", "redditstatic.com", "redd.it"],
  linkedin: ["linkedin.com", "licdn.com"],
  pinterest: ["pinterest.com", "pinimg.com"],
  snapchat: ["snapchat.com", "sc-cdn.net"],
  bluesky: ["bsky.app", "bsky.social"],
  threads: ["threads.net"],
  tumblr: ["tumblr.com"],
  netflix: ["netflix.com", "nflxvideo.net", "nflximg.net", "nflxext.com"],
  disneyplus: ["disneyplus.com", "disney-plus.net", "dssott.com"],
  spotify: ["spotify.com", "scdn.co"],
  twitch: ["twitch.tv", "ttvnw.net", "jtvnw.net"],
  soundcloud: ["soundcloud.com", "sndcdn.com"],
  applemusic: ["music.apple.com"],
  hbomax: ["max.com", "hbomax.com"],
  primevideo: ["primevideo.com"],
  crunchyroll: ["crunchyroll.com"],
  vimeo: ["vimeo.com", "vimeocdn.com"],
  deezer: ["deezer.com", "dzcdn.net"],
  tidal: ["tidal.com"],
  steam: ["steampowered.com", "steamcommunity.com", "steamstatic.com", "steamcontent.com"],
  epicgames: ["epicgames.com", "unrealengine.com"],
  playstation: ["playstation.com", "playstation.net", "sonyentertainmentnetwork.com"],
  xbox: ["xbox.com", "xboxlive.com"],
  battlenet: ["battle.net", "blizzard.com"],
  riotgames: ["riotgames.com", "leagueoflegends.com", "playvalorant.com", "riotcdn.net"],
  nintendo: ["nintendo.com", "nintendo.net", "nintendoswitch.com"],
  ea: ["ea.com", "origin.com"],
  ubisoft: ["ubisoft.com", "ubi.com"],
  gog: ["gog.com"],
  roblox: ["roblox.com", "rbxcdn.com"],
  rockstar: ["rockstargames.com"],
  binance: ["binance.com"],
  coinbase: ["coinbase.com"],
  bybit: ["bybit.com"],
  kraken: ["kraken.com"],
  tradingview: ["tradingview.com"],
  paypal: ["paypal.com", "paypalobjects.com"],
  wise: ["wise.com"],
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
