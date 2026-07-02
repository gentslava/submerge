export type KindHint =
  | "vless"
  | "hysteria2"
  | "vmess"
  | "trojan"
  | "ss"
  | "tuic"
  | "wireguard"
  | "amneziawg"
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
  vpn: "amneziawg", // Amnezia vpn:// blob
};

// Live preview of what a pasted value will become — a protocol for a single-node
// link, happ for happ://, else a subscription/deep-link. Best-effort; the server's
// detectKind is authoritative on submit.
export function detectKindHint(value: string): KindHint {
  const v = value.trim();
  if (!v) return "unknown";
  // A .conf (INI) has no scheme, so detect it before the scheme-based checks.
  if (/^\s*\[Interface\]/m.test(v) && /PrivateKey\s*=/i.test(v))
    return /^\s*(Jc|Jmin|Jmax|S1|S2|S3|S4|H1|H2|H3|H4|Itime|I1|I2|I3|I4|I5|J1|J2|J3)\s*=/im.test(v)
      ? "amneziawg"
      : "wireguard";
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
  wireguard: "WireGuard",
  amneziawg: "AmneziaWG",
  happ: "happ (зашифр.)",
  sub: "подписка / deep-link",
  unknown: "база64 / неизвестно",
};
