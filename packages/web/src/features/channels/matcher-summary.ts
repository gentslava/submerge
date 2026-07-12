export function fitMatcherItems({
  availableWidth,
  itemWidths,
  counterWidths,
  suffixWidth,
  gap,
}: {
  availableWidth: number;
  itemWidths: number[];
  counterWidths: number[];
  suffixWidth: number;
  gap: number;
}): number {
  const collapsedWidth = (counterWidths[itemWidths.length] ?? 0) + suffixWidth + gap;
  if (collapsedWidth > availableWidth) return 0;

  let itemWidth = 0;

  for (let visibleCount = 1; visibleCount <= itemWidths.length; visibleCount += 1) {
    itemWidth += itemWidths[visibleCount - 1] ?? 0;
    const remainingCount = itemWidths.length - visibleCount;
    const counterWidth = remainingCount > 0 ? (counterWidths[remainingCount] ?? 0) : 0;
    const partCount = visibleCount + (remainingCount > 0 ? 1 : 0) + 1;
    const totalWidth = itemWidth + counterWidth + suffixWidth + gap * (partCount - 1);

    if (totalWidth > availableWidth) return visibleCount - 1;
  }

  return itemWidths.length;
}
