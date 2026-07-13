import { CHANNEL_PRESETS, type ChannelMatcher } from "@submerge/shared";

export interface MatcherSummaryItem {
  key: string;
  value: string;
  monospace: boolean;
}

function ruleProviderLabel(url: string): string {
  try {
    return new URL(url).hostname || url;
  } catch {
    return url;
  }
}

export function matcherSummaryItems(matcher: ChannelMatcher): MatcherSummaryItem[] {
  const presetItems = matcher.presets.map((id, index) => {
    const label = CHANNEL_PRESETS.find((preset) => preset.id === id)?.label;
    return {
      key: `preset-${id}-${index}`,
      value: label ?? `preset:${id}`,
      monospace: label == null,
    };
  });
  return [
    ...presetItems,
    ...matcher.domains.map((value, index) => ({
      key: `domain-${value}-${index}`,
      value,
      monospace: true,
    })),
    ...matcher.keywords.map((value, index) => ({
      key: `keyword-${value}-${index}`,
      value: `ключ:${value}`,
      monospace: true,
    })),
    ...matcher.ruleProviders.map((ref, index) => ({
      key: `provider-${ref.url}-${ref.behavior}-${index}`,
      value: `список:${ruleProviderLabel(ref.url)}`,
      monospace: true,
    })),
    ...matcher.geosite.map((value, index) => ({
      key: `geosite-${value}-${index}`,
      value: `geosite:${value}`,
      monospace: true,
    })),
    ...matcher.geoip.map((value, index) => ({
      key: `geoip-${value}-${index}`,
      value: `geoip:${value}`,
      monospace: true,
    })),
    ...matcher.cidrs.map((value, index) => ({
      key: `cidr-${value}-${index}`,
      value,
      monospace: true,
    })),
  ];
}

export function fitMatcherItems({
  availableWidth,
  itemWidths,
  counterWidths,
  gap,
}: {
  availableWidth: number;
  itemWidths: number[];
  counterWidths: number[];
  gap: number;
}): number {
  const collapsedWidth = counterWidths[itemWidths.length] ?? 0;
  if (collapsedWidth > availableWidth) return 0;

  let itemWidth = 0;

  for (let visibleCount = 1; visibleCount <= itemWidths.length; visibleCount += 1) {
    itemWidth += itemWidths[visibleCount - 1] ?? 0;
    const remainingCount = itemWidths.length - visibleCount;
    const counterWidth = remainingCount > 0 ? (counterWidths[remainingCount] ?? 0) : 0;
    const partCount = visibleCount + (remainingCount > 0 ? 1 : 0);
    const totalWidth = itemWidth + counterWidth + gap * Math.max(0, partCount - 1);

    if (totalWidth > availableWidth) return visibleCount - 1;
  }

  return itemWidths.length;
}
