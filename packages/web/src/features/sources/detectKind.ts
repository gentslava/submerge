export type KindHint = "vless" | "happ" | "sub" | "unknown";

export function detectKindHint(value: string): KindHint {
  const v = value.trim();
  if (!v) return "unknown";
  if (v.startsWith("vless://")) return "vless";
  if (/^happ:\/\//i.test(v)) return "happ";
  if (/^https?:\/\//i.test(v)) return "sub";
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(v)) return "sub";
  return "unknown";
}

export const KIND_LABEL: Record<KindHint, string> = {
  vless: "одиночный vless",
  happ: "happ (зашифр.)",
  sub: "подписка / deep-link",
  unknown: "база64 / неизвестно",
};
