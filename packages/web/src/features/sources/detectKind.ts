export type KindHint =
  | "vless"
  | "hysteria2"
  | "vmess"
  | "trojan"
  | "ss"
  | "tuic"
  | "happ"
  | "sub"
  | "unknown";

// Single-node link schemes → the protocol hint (mirrors the server's SINGLE_LINK
// table). `hy2` is an alias for hysteria2. Kept in sync with detectKind on the server.
const SINGLE_LINK_HINT: Record<string, KindHint> = {
  vless: "vless",
  hysteria2: "hysteria2",
  hy2: "hysteria2",
  vmess: "vmess",
  trojan: "trojan",
  ss: "ss",
  tuic: "tuic",
};

// Live preview of what a pasted value will become — a protocol for a single-node
// link, happ for happ://, else a subscription/deep-link. Best-effort; the server's
// detectKind is authoritative on submit.
export function detectKindHint(value: string): KindHint {
  const v = value.trim();
  if (!v) return "unknown";
  const scheme = v.match(/^([a-z][a-z0-9+.-]*):\/\//i)?.[1]?.toLowerCase();
  if (scheme && SINGLE_LINK_HINT[scheme]) return SINGLE_LINK_HINT[scheme];
  if (/^happ:\/\//i.test(v)) return "happ";
  if (/^https?:\/\//i.test(v)) return "sub";
  if (scheme) return "sub"; // some other scheme:// → subscription / client deep-link
  return "unknown";
}

export const KIND_LABEL: Record<KindHint, string> = {
  vless: "VLESS",
  hysteria2: "Hysteria2",
  vmess: "VMess",
  trojan: "Trojan",
  ss: "Shadowsocks",
  tuic: "TUIC",
  happ: "happ (зашифр.)",
  sub: "подписка / deep-link",
  unknown: "база64 / неизвестно",
};
