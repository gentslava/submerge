// Ingest-слой: разбор источников узлов.
//  - vless:// (ws+tls / tcp+reality / grpc / xhttp / http)
//  - подписки: clash/mihomo yaml | base64-список | v2ray/xray JSON (outbounds)
//  - happ:// — через сервис happ-decoder (официальный бинарь Happ + перехват sub-URL)
import yaml from 'js-yaml';

const HAPP_DECODER_URL = process.env.HAPP_DECODER_URL || 'http://happ-decoder:8080';

// ── Извлечение URL подписки из клиентского deep-link ─────────────
// Покрывает: scheme://action?url=<encoded> (clash/sing-box/v2rayng) и
//            scheme://action/<plain-url> (incy/happ-add/streisand/hiddify).
export function extractSubUrl(value) {
  const v = (value || '').trim();
  if (/^https?:\/\//i.test(v)) return v;                 // это уже сам URL
  try {
    const u = new URL(v);
    const q = u.searchParams.get('url') || u.searchParams.get('link');
    if (q && /^https?:\/\//i.test(q)) return q;          // ?url=<encoded>
  } catch { /* не парсится как URL */ }
  const m = v.match(/https?:\/\/[^\s"'<>]+/i);           // http(s) где-то в строке
  if (m) { try { return decodeURIComponent(m[0]); } catch { return m[0]; } }
  return null;
}

// ── Автоопределение типа источника ───────────────────────────────
export function detectKind(value) {
  const v = (value || '').trim();
  if (!v) throw new Error('пустая строка');
  if (v.startsWith('vless://')) return 'vless';
  if (/^happ:\/\/crypt/i.test(v)) return 'happ';         // зашифрованный happ → decoder
  if (/^(vmess|trojan|ss|ssr|hysteria2?|tuic):\/\//i.test(v))
    throw new Error('одиночные узлы пока поддержаны только для vless:// (остальное — через подписку)');
  if (extractSubUrl(v)) return 'sub';                    // URL или deep-link клиента (incy/clash/sing-box/happ-add/…)
  if (/^happ:\/\//i.test(v)) return 'happ';              // happ:// без URL внутри → decoder
  try {
    const d = Buffer.from(v.replace(/\s+/g, ''), 'base64').toString('utf8');
    if (d.includes('://')) return 'sub';                 // base64-контент подписки, вставленный напрямую
  } catch { /* не base64 */ }
  throw new Error('не удалось определить тип: vless:// , happ:// , URL подписки или deep-link клиента');
}

// ── vless:// → mihomo proxy ───────────────────────────────────────
export function parseVless(uri) {
  const u = new URL(uri.trim());
  if (u.protocol !== 'vless:') throw new Error('не vless:// ссылка');
  const q = u.searchParams;
  const server = u.hostname;
  const port = Number(u.port) || 443;
  const uuid = decodeURIComponent(u.username);
  if (!uuid) throw new Error('не удалось разобрать UUID');
  const name = u.hash ? decodeURIComponent(u.hash.slice(1)) : `${server}:${port}`;

  const security = q.get('security') || 'none';
  const net = q.get('type') || 'tcp';
  const sni = q.get('sni') || q.get('host') || server;
  const fp = q.get('fp') || 'chrome';
  const flow = q.get('flow') || '';
  const host = q.get('host') || '';
  const path = q.get('path') ? decodeURIComponent(q.get('path')) : '/';

  const p = { name, type: 'vless', server, port, uuid, udp: true, 'client-fingerprint': fp, network: net === 'h2' ? 'http' : net };
  if (flow) p.flow = flow;
  if (security === 'tls' || security === 'reality') {
    p.tls = true;
    p.servername = sni;
    if (security === 'reality') p['reality-opts'] = { 'public-key': q.get('pbk') || '', 'short-id': q.get('sid') || '' };
  }
  if (net === 'ws') p['ws-opts'] = { path, headers: { Host: host || sni } };
  else if (net === 'grpc') p['grpc-opts'] = { 'grpc-service-name': q.get('serviceName') || path.replace(/^\//, '') };
  else if (net === 'http' || net === 'h2') p['h2-opts'] = { path, host: host ? [host] : [sni] };
  else if (net === 'xhttp') p['xhttp-opts'] = { path, host: host || sni, mode: q.get('mode') || 'auto' };
  return p;
}

// ── v2ray/xray JSON outbound → mihomo proxy (best-effort, для формата Happ) ──
function v2rayOutboundToMihomo(ob, remark) {
  if (!ob || ob.protocol !== 'vless') return null;            // freedom/blackhole/direct пропускаем
  const vnext = ob.settings?.vnext?.[0];
  const user = vnext?.users?.[0];
  if (!vnext || !user) return null;
  const ss = ob.streamSettings || {};
  const net = ss.network || 'tcp';
  const p = {
    name: remark || ob.tag || `${vnext.address}:${vnext.port}`,
    type: 'vless', server: vnext.address, port: Number(vnext.port), uuid: user.id, udp: true,
    network: net === 'h2' ? 'http' : net,
  };
  if (user.flow) p.flow = user.flow;
  const sec = ss.security || 'none';
  if (sec === 'tls' || sec === 'reality') {
    p.tls = true;
    const t = ss.tlsSettings || ss.realitySettings || {};
    p.servername = t.serverName || vnext.address;
    if (t.fingerprint) p['client-fingerprint'] = t.fingerprint;
    if (sec === 'reality') {
      const r = ss.realitySettings || {};
      p['reality-opts'] = { 'public-key': r.publicKey || '', 'short-id': r.shortId || '' };
    }
  }
  if (net === 'ws') p['ws-opts'] = { path: ss.wsSettings?.path || '/', headers: ss.wsSettings?.headers || {} };
  else if (net === 'grpc') p['grpc-opts'] = { 'grpc-service-name': ss.grpcSettings?.serviceName || '' };
  return p;
}

// ── sing-box outbound → mihomo proxy (формат sing-box: type/server/server_port) ──
function singBoxOutboundToMihomo(ob) {
  if (!ob || ob.type !== 'vless' || !ob.server) return null;
  const net = ob.transport?.type || 'tcp';
  const p = {
    name: ob.tag || `${ob.server}:${ob.server_port}`,
    type: 'vless', server: ob.server, port: Number(ob.server_port), uuid: ob.uuid, udp: true, network: net,
  };
  if (ob.flow) p.flow = ob.flow;
  const tls = ob.tls;
  if (tls?.enabled) {
    p.tls = true;
    p.servername = tls.server_name || ob.server;
    if (tls.utls?.fingerprint) p['client-fingerprint'] = tls.utls.fingerprint;
    if (tls.reality?.enabled) p['reality-opts'] = { 'public-key': tls.reality.public_key || '', 'short-id': tls.reality.short_id || '' };
  }
  if (net === 'ws') p['ws-opts'] = { path: ob.transport?.path || '/', headers: ob.transport?.headers || {} };
  else if (net === 'grpc') p['grpc-opts'] = { 'grpc-service-name': ob.transport?.service_name || '' };
  return p;
}

// ── Разбор содержимого подписки ──────────────────────────────────
export function parseProxiesFromText(text) {
  // 1) clash/mihomo yaml
  try {
    const doc = yaml.load(text);
    if (doc && Array.isArray(doc.proxies) && doc.proxies.length) return doc.proxies;
  } catch { /* не yaml */ }

  // 2) v2ray/xray JSON (массив профилей с outbounds, либо {outbounds:[…]})
  try {
    const j = JSON.parse(text);
    const profiles = Array.isArray(j) ? j : (j.outbounds ? [j] : null);
    if (profiles) {
      const out = [];
      for (const prof of profiles) for (const ob of (prof.outbounds || [])) {
        const p = v2rayOutboundToMihomo(ob, prof.remarks) || singBoxOutboundToMihomo(ob);
        if (p) out.push(p);
      }
      if (out.length) return out;
    }
  } catch { /* не json */ }

  // 3) base64-список или plain список ссылок
  let decoded = text;
  try {
    const b = Buffer.from(text.replace(/\s+/g, ''), 'base64').toString('utf8');
    if (b.includes('://')) decoded = b;
  } catch { /* не base64 */ }
  return decoded.split(/\r?\n/).map((s) => s.trim())
    .filter((s) => s.startsWith('vless://'))
    .map((s) => { try { return parseVless(s); } catch { return null; } })
    .filter(Boolean);
}

export async function fetchSubscription(url) {
  // X-Hwid нужен провайдерам с привязкой к устройству (иначе отдают заглушку)
  const headers = { 'User-Agent': 'clash.meta', 'X-Device-Os': 'Android' };
  if (process.env.SUBMERGE_HWID) headers['X-Hwid'] = process.env.SUBMERGE_HWID;
  const res = await fetch(url.trim(), { headers });
  if (!res.ok) throw new Error(`подписка вернула HTTP ${res.status}`);
  const proxies = parseProxiesFromText(await res.text());
  if (!proxies.length) throw new Error('в подписке не нашлось узлов (clash-yaml / v2ray-json / base64)');
  return proxies;
}

// ── happ:// → happ-decoder сервис → sub-URL/тело → узлы ──────────
export async function ingestHapp(link) {
  let r;
  try {
    r = await fetch(`${HAPP_DECODER_URL}/decode`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ link: link.trim() }),
      signal: AbortSignal.timeout(70000),
    });
  } catch (e) {
    throw new Error(`happ-decoder недоступен/таймаут (${HAPP_DECODER_URL}): ${e.message}`);
  }
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.ok) throw new Error(j.error || `happ-decoder вернул HTTP ${r.status}`);

  let proxies = j.body ? parseProxiesFromText(j.body) : [];
  if (!proxies.length && j.url) {
    try { proxies = await fetchSubscription(j.url); } catch { /* разберём ниже */ }
  }
  if (!proxies.length) {
    // подписка декодирована и распознана как формат, но активных узлов нет → вероятно истекла
    const decoded = j.body && (j.body.includes('"outbounds"') || j.body.includes('proxies:') || j.body.includes('://'));
    if (decoded) throw new Error(`happ декодирован (${j.url || '—'}), но активных узлов нет — подписка, вероятно, истекла/неактивна`);
    const sample = (j.body || '').slice(0, 240).replace(/\s+/g, ' ');
    console.log(`[happ] формат не распознан. url=${j.url} sample=${sample}`);
    throw new Error(`happ декодирован (${j.url || '—'}), но формат подписки не распознан — структура в логах combine`);
  }
  return { via: j.url || 'happ', proxies };
}
