import { type Proxy as ProxyConfig, proxySchema } from "@submerge/shared";
import * as yaml from "js-yaml";
import { z } from "zod";
import { singBoxOutboundToMihomo, v2rayOutboundToMihomo } from "./parse.js";

const objectSchema = z.record(z.string(), z.unknown());
const serviceTypes = new Set(["freedom", "blackhole", "direct", "block", "dns"]);
const nativeTypes = new Set([
  "vless",
  "vmess",
  "trojan",
  "ss",
  "hysteria2",
  "tuic",
  "wireguard",
  "socks5",
  "http",
]);
const portSchema = z
  .union([z.number(), z.string().regex(/^\d+$/)])
  .pipe(z.coerce.number<string | number>().int().min(1).max(65535));
const textSchema = z
  .string()
  .trim()
  .min(1)
  .refine((value) => !/[<>\r\n]/.test(value));
const addressSchema = textSchema.refine((value) => !/[\s/@?#]/.test(value));

function object(value: unknown): Record<string, unknown> {
  const result = objectSchema.safeParse(value);
  if (!result.success) throw new Error("Ожидается объект конфига узла");
  return result.data;
}

function requiredText(value: unknown, label: string): string {
  const parsed = textSchema.safeParse(value);
  if (!parsed.success) throw new Error(`Некорректный ${label} узла: укажите реальное значение`);
  return parsed.data;
}

function validatePassword(value: unknown): void {
  // Credentials are opaque: spaces, angle brackets and newlines can be part of
  // a legitimate password. Validate presence without rewriting its bytes.
  if (!z.string().min(1).safeParse(value).success) throw new Error("Некорректный пароль узла");
}

function endpoint(address: unknown, port: unknown): { server: string; port: number } {
  const parsedAddress = addressSchema.safeParse(address);
  if (!parsedAddress.success) throw new Error("Некорректный адрес узла");
  const parsedPort = portSchema.safeParse(port);
  if (!parsedPort.success) throw new Error("Некорректный порт узла: допустимо 1–65535");
  return { server: parsedAddress.data, port: parsedPort.data };
}

function onlyEntry(value: unknown): Record<string, unknown> {
  if (!Array.isArray(value) || value.length !== 1)
    throw new Error("Конфиг должен содержать ровно один сервер и одного пользователя");
  return object(value[0]);
}

interface Candidate {
  value: Record<string, unknown>;
  name: unknown;
}

function candidates(value: unknown, name?: unknown): Candidate[] {
  if (Array.isArray(value)) return value.flatMap((entry) => candidates(entry, name));
  const config = object(value);
  if ("outbounds" in config && "proxies" in config)
    throw new Error("Неоднозначный конфиг: одновременно outbounds и proxies");
  const children = config.outbounds ?? config.proxies;
  if (children !== undefined) {
    if (!Array.isArray(children)) throw new Error("Список узлов конфига должен быть массивом");
    return children.flatMap((entry) => candidates(entry, config.remarks ?? name));
  }
  const type = config.protocol ?? config.type;
  return typeof type === "string" && serviceTypes.has(type) ? [] : [{ value: config, name }];
}

function normalizeWireguard(value: Record<string, unknown>): Record<string, unknown> {
  const ipv4 = z.union([z.ipv4(), z.cidrv4()]);
  const ipv6 = z.union([z.ipv6(), z.cidrv6()]);
  if (value.ip === undefined && value.ipv6 === undefined)
    throw new Error("WireGuard: нужен локальный ip или ipv6");
  if (
    (value.ip !== undefined && !ipv4.safeParse(value.ip).success) ||
    (value.ipv6 !== undefined && !ipv6.safeParse(value.ipv6).success)
  )
    throw new Error("WireGuard: некорректный локальный IP/CIDR");
  const key = z.string().regex(/^[A-Za-z0-9+/]{43}=$/);
  if (!key.safeParse(value["private-key"]).success)
    throw new Error("WireGuard: нужен private-key в base64 (32 байта)");
  const peer = value.peers === undefined ? value : onlyEntry(value.peers);
  if (
    !key.safeParse(peer["public-key"]).success ||
    (peer["pre-shared-key"] !== undefined && !key.safeParse(peer["pre-shared-key"]).success)
  )
    throw new Error("WireGuard: некорректный public-key или pre-shared-key");
  const allowedIps = z.array(z.union([z.cidrv4(), z.cidrv6()])).min(1);
  if (
    (value.peers !== undefined || peer["allowed-ips"] !== undefined) &&
    !allowedIps.safeParse(peer["allowed-ips"]).success
  )
    throw new Error("WireGuard: нужен непустой allowed-ips с корректными CIDR");
  if (
    peer.reserved !== undefined &&
    !z
      .union([
        z.array(z.number().int().min(0).max(255)).length(3),
        z.string().regex(/^[A-Za-z0-9+/]{4}$/),
      ])
      .safeParse(peer.reserved).success
  )
    throw new Error("WireGuard: reserved должен содержать 3 байта");
  const target = endpoint(peer.server, peer.port);
  return {
    ...value,
    ...target,
    ...(value.peers === undefined ? {} : { peers: [{ ...peer, ...target }] }),
  };
}

function validateProxy(value: unknown): ProxyConfig {
  const config = object(value);
  const parsed = proxySchema.safeParse(
    config.type === "wireguard" ? normalizeWireguard(config) : config,
  );
  if (!parsed.success) throw new Error("Некорректный конфиг узла: нужны name, type, server и port");
  const proxy = parsed.data;
  if (!nativeTypes.has(proxy.type))
    throw new Error(`Не поддерживается протокол узла: ${proxy.type}`);
  const target = endpoint(proxy.server, proxy.port);
  proxy.server = target.server;
  proxy.port = target.port;
  proxy.name = requiredText(proxy.name, "имя");
  if (["vless", "vmess", "tuic"].includes(proxy.type)) {
    if (!z.uuid().safeParse(proxy.uuid).success) throw new Error("Некорректный UUID узла");
  }
  if (["trojan", "ss", "hysteria2", "tuic"].includes(proxy.type)) validatePassword(proxy.password);
  if (proxy.type === "ss") requiredText(proxy.cipher, "метод шифрования");
  if (proxy["dialer-proxy"]) throw new Error("Импорт узла с цепочкой прокси не поддерживается");
  if (proxy["reality-opts"] !== undefined) {
    const reality = z
      .object({
        "public-key": z.string().regex(/^[A-Za-z0-9_-]{43}$/),
        "short-id": z
          .string()
          .regex(/^(?:[0-9a-fA-F]{2}){0,8}$/)
          .default(""),
      })
      .safeParse(proxy["reality-opts"]);
    if (!reality.success) throw new Error("Некорректные publicKey или shortId Reality");
    if (proxy.tls !== true) throw new Error("Reality требует TLS");
  }
  return proxy;
}

function transport(value: unknown): "tcp" | "ws" | "grpc" {
  const raw = typeof value === "string" ? value.toLowerCase() : value;
  const network = raw === "raw" ? "tcp" : raw === "websocket" ? "ws" : (raw ?? "tcp");
  if (network !== "tcp" && network !== "ws" && network !== "grpc")
    throw new Error(`Не поддерживается транспорт ${String(network)}: используйте конфиг mihomo`);
  return network;
}

function xray(candidate: Candidate): ProxyConfig {
  const outbound = candidate.value;
  const protocol = outbound.protocol;
  if (protocol !== "vless" && protocol !== "vmess" && protocol !== "trojan")
    throw new Error(`Не поддерживается протокол Xray: ${String(protocol)}`);
  const settings = object(outbound.settings);
  const server =
    protocol === "trojan"
      ? settings.servers === undefined
        ? settings
        : onlyEntry(settings.servers)
      : settings.vnext !== undefined
        ? onlyEntry(settings.vnext)
        : settings;
  const user =
    protocol === "trojan"
      ? server
      : settings.vnext !== undefined
        ? onlyEntry(server.users)
        : settings;
  const target = endpoint(server.address, server.port);
  const stream = outbound.streamSettings === undefined ? {} : object(outbound.streamSettings);
  const network = transport(stream.method ?? stream.network);
  const security = stream.security ?? "none";
  if (!["none", "tls", "reality"].includes(String(security)))
    throw new Error(`Не поддерживается защита транспорта: ${String(security)}`);
  if (outbound.proxySettings || objectSchema.safeParse(outbound.mux).data?.enabled === true)
    throw new Error("Импорт узла с цепочкой или Xray mux не поддерживается");
  if (protocol === "vless" && user.encryption && user.encryption !== "none")
    throw new Error("Не поддерживается Xray VLESS encryption: используйте конфиг mihomo");
  for (const settings of [stream.tcpSettings, stream.rawSettings]) {
    if (settings === undefined) continue;
    const header = object(object(settings).header ?? {});
    if ((header.type ?? "none") !== "none")
      throw new Error("Не поддерживается TCP header: используйте конфиг mihomo");
  }
  const normalizedSettings =
    protocol === "trojan"
      ? { servers: [{ ...server, address: target.server, port: target.port }] }
      : { vnext: [{ ...server, address: target.server, port: target.port, users: [user] }] };
  const proxy = v2rayOutboundToMihomo(
    { ...outbound, settings: normalizedSettings, streamSettings: { ...stream, network } },
    typeof candidate.name === "string" ? candidate.name : undefined,
  );
  if (!proxy) throw new Error("Не удалось преобразовать конфиг Xray");
  proxy.network = network;
  if (security === "tls" || security === "reality") {
    const tls = object(stream[security === "reality" ? "realitySettings" : "tlsSettings"] ?? {});
    proxy.tls = true;
    if (tls.allowInsecure !== undefined)
      proxy["skip-cert-verify"] = z.boolean().parse(tls.allowInsecure);
    if (tls.alpn !== undefined) proxy.alpn = z.array(z.string()).parse(tls.alpn);
    if (tls.fingerprint) proxy["client-fingerprint"] = requiredText(tls.fingerprint, "fingerprint");
    if (protocol === "trojan") proxy.sni = tls.serverName || target.server;
    else proxy.servername = tls.serverName || target.server;
    if (security === "reality")
      proxy["reality-opts"] = {
        "public-key": tls.publicKey ?? tls.password,
        "short-id": tls.shortId ?? "",
      };
  }
  if (network === "ws") {
    const ws = object(stream.wsSettings ?? {});
    const headers = z.record(z.string(), z.string()).parse(ws.headers ?? {});
    if (ws.host) {
      for (const key of Object.keys(headers)) {
        if (key.toLowerCase() === "host") delete headers[key];
      }
      headers.Host = requiredText(ws.host, "WebSocket host");
    }
    proxy["ws-opts"] = { path: ws.path || "/", headers };
  }
  if (network === "grpc") {
    const grpc = object(stream.grpcSettings ?? {});
    if (grpc.multiMode === true || (grpc.authority !== undefined && grpc.authority !== ""))
      throw new Error("Не поддерживается gRPC multiMode или authority");
    proxy["grpc-opts"] = { "grpc-service-name": grpc.serviceName ?? "" };
  }
  return validateProxy(proxy);
}

function singBox(outbound: Record<string, unknown>): ProxyConfig {
  if (outbound.detour) throw new Error("Импорт узла с цепочкой прокси не поддерживается");
  if (outbound.plugin || outbound.plugin_opts)
    throw new Error("Не поддерживается плагин sing-box: используйте конфиг mihomo");
  const target = endpoint(outbound.server, outbound.server_port);
  const options = outbound.transport === undefined ? {} : object(outbound.transport);
  const network = transport(options.type);
  if (outbound.transport && !["vless", "vmess", "trojan"].includes(String(outbound.type)))
    throw new Error("Не поддерживается транспорт для этого протокола");
  const proxy = singBoxOutboundToMihomo({
    ...outbound,
    server: target.server,
    server_port: target.port,
  });
  if (!proxy) throw new Error(`Не поддерживается протокол sing-box: ${String(outbound.type)}`);
  if (["vless", "vmess", "trojan"].includes(proxy.type)) proxy.network = network;
  const tls = object(outbound.tls ?? {});
  const supportedTlsKeys = new Set([
    "enabled",
    "server_name",
    "insecure",
    "alpn",
    "utls",
    "reality",
  ]);
  const unsupportedTlsKey = Object.keys(tls).find((key) => !supportedTlsKeys.has(key));
  if (unsupportedTlsKey)
    throw new Error(
      `Не поддерживается параметр TLS ${unsupportedTlsKey}: используйте конфиг mihomo`,
    );
  if (tls.insecure !== undefined) proxy["skip-cert-verify"] = z.boolean().parse(tls.insecure);
  if (tls.alpn !== undefined) proxy.alpn = z.array(z.string()).parse(tls.alpn);
  if (tls.enabled === true) {
    proxy.tls = true;
    if (proxy.type === "vless" || proxy.type === "vmess")
      proxy.servername = tls.server_name || target.server;
    else proxy.sni = tls.server_name || target.server;
    const utls = object(tls.utls ?? {});
    if (utls.enabled === true && utls.fingerprint)
      proxy["client-fingerprint"] = requiredText(utls.fingerprint, "fingerprint");
  }
  if (network === "ws")
    proxy["ws-opts"] = { path: options.path ?? "/", headers: options.headers ?? {} };
  if (network === "grpc") proxy["grpc-opts"] = { "grpc-service-name": options.service_name ?? "" };
  return validateProxy(proxy);
}

export function parseSingleNodeConfig(text: string): ProxyConfig {
  let document: unknown;
  try {
    document = JSON.parse(text);
  } catch {
    try {
      document = yaml.load(text);
    } catch {
      throw new Error("Некорректный JSON/YAML: проверьте синтаксис конфига");
    }
  }
  const entries = candidates(document);
  if (entries.length === 0) throw new Error("Прокси-узел в конфиге не найден");
  if (entries.length !== 1) throw new Error("Конфиг должен содержать ровно один прокси-узел");
  const candidate = entries[0];
  if (!candidate) throw new Error("Прокси-узел в конфиге не найден");
  if (candidate.value.protocol !== undefined) return xray(candidate);
  if (candidate.value.server_port !== undefined) return singBox(candidate.value);
  return validateProxy(candidate.value);
}
