// combine — control-plane: ingest источников -> генерация config.yaml -> reload mihomo -> статус.
import http from 'node:http';
import { readFileSync, existsSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { parseVless, fetchSubscription, detectKind, ingestHapp, extractSubUrl, parseProxiesFromText } from './parse.js';
import { writeConfig } from './generate.js';

const MIHOMO_API = process.env.MIHOMO_API || 'http://mihomo:9090';
const SECRET = process.env.MIHOMO_SECRET || 'poc';
const CFG_DIR = '/mihomo';
const CFG_HOST = `${CFG_DIR}/config.yaml`;                 // куда combine пишет
const CFG_IN_MIHOMO = '/root/.config/mihomo/config.yaml';  // как видит mihomo
const SRC_PATH = `${CFG_DIR}/sources.json`;

// Стабильный HWID для подписок с привязкой к устройству (Black Cat VPN и т.п.).
const HWID_PATH = `${CFG_DIR}/hwid.txt`;
(() => {
  let hwid = process.env.SUBMERGE_HWID || '';
  if (!hwid && existsSync(HWID_PATH)) { try { hwid = readFileSync(HWID_PATH, 'utf8').trim(); } catch {} }
  if (!hwid) { hwid = randomBytes(16).toString('hex'); try { writeFileSync(HWID_PATH, hwid); } catch {} }
  process.env.SUBMERGE_HWID = hwid;
})();

let sources = [];
if (existsSync(SRC_PATH)) { try { sources = JSON.parse(readFileSync(SRC_PATH, 'utf8')); } catch {} }
const persist = () => writeFileSync(SRC_PATH, JSON.stringify(sources, null, 2));

function allProxies() {
  const out = [];
  for (const s of sources) {
    if (s.kind === 'vless') out.push(s.proxy);
    else if (s.kind === 'sub' || s.kind === 'happ') out.push(...(s.proxies || []));
  }
  const seen = new Set();
  for (const p of out) {
    let n = p.name;
    while (seen.has(n)) n = `${p.name}-${Math.random().toString(36).slice(2, 5)}`;
    p.name = n; seen.add(n);
  }
  return out;
}

async function mihomo(path, init = {}) {
  return fetch(`${MIHOMO_API}${path}`, {
    ...init,
    headers: { ...(init.headers || {}), Authorization: `Bearer ${SECRET}` },
  });
}

async function reload() {
  const proxies = allProxies();
  writeConfig(CFG_HOST, proxies);
  const r = await mihomo('/configs?force=true', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path: CFG_IN_MIHOMO }),
  });
  return { ok: r.ok, status: r.status, nodes: proxies.length };
}

const readBody = (req) => new Promise((res) => { let b = ''; req.on('data', (c) => (b += c)); req.on('end', () => res(b)); });
const json = (res, obj, code = 200) => { res.statusCode = code; res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(obj)); };

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://x');
    const { pathname } = url;

    if (req.method === 'GET' && pathname === '/') {
      res.setHeader('content-type', 'text/html; charset=utf-8');
      return res.end(readFileSync(new URL('./public/index.html', import.meta.url)));
    }

    if (req.method === 'GET' && pathname === '/api/state') {
      let proxies = null, err = null;
      try { proxies = await (await mihomo('/proxies')).json(); } catch (e) { err = String(e); }
      return json(res, {
        sources: sources.map((s) => ({ kind: s.kind, label: s.label, count: s.kind === 'vless' ? 1 : (s.proxies || []).length, hwid: !!s.hwid })),
        proxies, err,
      });
    }

    if (req.method === 'POST' && pathname === '/api/sources') {
      const { value, hwid } = JSON.parse(await readBody(req));
      const kind = detectKind(value);            // тип определяем автоматически
      if (kind === 'vless') {
        const proxy = parseVless(value);
        sources.push({ kind: 'vless', label: proxy.name, proxy });
      } else if (kind === 'sub') {
        const url = extractSubUrl(value);                 // из deep-link клиента или сам URL
        const proxies = url ? await fetchSubscription(url, !!hwid) : parseProxiesFromText(value);
        if (!proxies.length) throw new Error('в подписке не нашлось узлов');
        sources.push({ kind: 'sub', label: url || 'inline-подписка', proxies, hwid: !!hwid });
      } else if (kind === 'happ') {
        const { via, proxies } = await ingestHapp(value, !!hwid);
        sources.push({ kind: 'happ', label: `happ → ${via}`, proxies, hwid: !!hwid });
      } else throw new Error('неизвестный тип источника');
      persist();
      return json(res, { ok: true, kind, result: await reload() });
    }

    if (req.method === 'POST' && pathname === '/api/select') {
      const { group, name } = JSON.parse(await readBody(req));
      const r = await mihomo(`/proxies/${encodeURIComponent(group)}`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name }),
      });
      return json(res, { ok: r.ok });
    }

    if (req.method === 'GET' && pathname.startsWith('/api/delay/')) {
      const name = decodeURIComponent(pathname.slice('/api/delay/'.length));
      const r = await mihomo(`/proxies/${encodeURIComponent(name)}/delay?timeout=3000&url=${encodeURIComponent('https://www.gstatic.com/generate_204')}`);
      return json(res, await r.json(), r.ok ? 200 : 502);
    }

    if (req.method === 'POST' && pathname === '/api/reset') {
      sources = []; persist();
      return json(res, { ok: true, result: await reload() });
    }

    json(res, { error: 'not found' }, 404);
  } catch (e) {
    json(res, { error: String(e.message || e) }, 500);
  }
});

server.listen(3000, () => console.log(`combine на :3000 → mihomo ${MIHOMO_API}`));

// синхронизируем mihomo с сохранёнными источниками при старте (с ретраями — ядро может ещё подниматься)
(async () => {
  for (let i = 0; i < 10; i++) {
    try { const r = await reload(); if (r.ok) { console.log('reload ok', r); return; } } catch {}
    await new Promise((r) => setTimeout(r, 2000));
  }
  console.log('reload: mihomo пока недоступен, применится при первом действии');
})();
