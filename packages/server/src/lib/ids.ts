export function isExactIdPermutation<T>(ids: readonly T[], expectedIds: readonly T[]): boolean {
  if (ids.length !== expectedIds.length) return false;
  const supplied = new Set(ids);
  return supplied.size === ids.length && expectedIds.every((id) => supplied.has(id));
}
