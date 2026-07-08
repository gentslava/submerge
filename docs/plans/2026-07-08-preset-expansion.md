# Preset expansion — more domains, more services, new categories

**Status:** in progress · **Date:** 2026-07-08 · **Scope:** `packages/shared/src/presets.ts` (registry + categories) · `packages/server/src/modules/channels/presets.ts` (curated domain lists). No engine, schema, or UI change — the matcher/registry model and `PresetChips` grouping already render whatever the registry holds.

## Why

The channel-routing presets shipped with a minimal set (one service per chip, 2–6 domains each) and a few categories. Two gaps: some existing services under-match (missing CDN/API/auth apexes), and whole classes of commonly-blocked services have no chip at all (dev tools, productivity/cloud, finance/crypto, plus more streaming/social/gaming/messenger/AI services).

This is pure curated-data growth: add entries to `CHANNEL_PRESETS` (+ categories in `PRESET_CATEGORIES`) and their domain lists in `PRESET_DOMAINS`. `resolveMatcherDomains` and the UI grouping are unchanged; the `Record<PresetId, string[]>` type guarantees every new id has a domain list.

## Rules for the lists

- Only owned **apex / second-level** domains (used as `DOMAIN-SUFFIX`), lowercase, syntactically valid (no protocol/space/comma — a bad entry would reject the whole mihomo reload).
- **No shared/ambiguous CDNs** that front unrelated traffic (e.g. `cloudflare.com`, bare `google.com`, `gstatic.com`) — route only service-owned domains.
- IP-range-only services (Telegram/Discord voice) are **out of scope** here — that needs `ipcidr` rule-providers from routing phase 4a (see that spec §9); revisit as a follow-up once 4a lands.

## Slices

1. **Expand existing** — enrich `openai`, `claude`, `gemini`, `youtube` with missing owned domains.
2. **More AI** — Suno, ElevenLabs, Runway, Ideogram, Character.AI, Poe, Leonardo.
3. **New category «Разработка»** — GitHub, GitLab, npm, PyPI, Docker Hub, Stack Overflow, JetBrains, Vercel, Netlify, Replit.
4. **New category «Продуктивность»** — Microsoft 365, Google Drive, Notion, Figma, Dropbox, Zoom, Atlassian.
5. **New category «Финансы»** — Binance, Coinbase, Bybit, Kraken, TradingView, PayPal, Wise.
6. **Expand Соцсети / Стриминг / Гейминг / Мессенджеры** — LinkedIn, Pinterest, Snapchat, Bluesky, Threads, Tumblr · Apple Music, Max, Prime Video, Crunchyroll, Vimeo, Deezer, Tidal · Nintendo, EA, Ubisoft, GOG, Roblox, Rockstar · Slack, LINE, WeChat, Element, Threema.
7. **Expand Видео** — Lampa (+ CUB), TMDB (metadata for Lampa/media apps), Dailymotion, Rumble, Bilibili, Odysee, Nebula, TED, Niconico.
8. **Expand P2P** — enrich the Torrent tracker pack (nyaa.si, yts.mx, eztv.re) and add Soulseek (P2P music). ⚠️ Tracker domains rotate under bans — this list will go stale; long-term candidate for an ipcidr/rule-provider (phase 4a), same as service IP coverage.

## Verify

`./node_modules/.bin/biome ci packages/ && pnpm typecheck && pnpm test` green; spot-check chips render grouped under the new category captions in «Маршрутизация».
