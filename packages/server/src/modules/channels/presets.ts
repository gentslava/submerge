// Expansion of a channel's matcher (custom domains + selected presets) into the
// flat domain list `buildMultiConfig` turns into DOMAIN-SUFFIX rules. The curated
// per-preset lists now live in @submerge/shared (PRESET_DOMAINS) so the web can
// list them in chip tooltips; re-exported here for existing server-side imports.
import { CHANNEL_PRESETS, type ChannelMatcher, PRESET_DOMAINS } from "@submerge/shared";

export { PRESET_DOMAINS };

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
