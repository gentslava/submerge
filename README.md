<p align="center">
  <img src="packages/web/public/logo.svg" width="96" alt="submerge" />
</p>

<h1 align="center">submerge</h1>

Self-hosted VPN subscription aggregator acting as a **client**: accepts subscriptions from multiple
providers (including encrypted `happ://` links), aggregates nodes, and serves a local
SOCKS5/HTTP proxy via the **mihomo** engine — with a web UI for management.

> Designed as a transparent upstream: your router-mihomo (or any client) connects to
> a single local proxy, while submerge manages the provider nodes behind it, picks the
> best one, and keeps subscriptions up to date.

## Features

- **Any node source through a single UI:** `vless://` (ws+tls / tcp+reality+vision / xhttp / grpc), subscriptions (clash-yaml / base64 / v2ray-json), `happ://`.
- **Auto-detection** of the pasted string type.
- **happ:// out of the box** — decoded by the official Happ binary (current keys), not a stale reverse decoder ([how it works](docs/adr/0001-happ-via-official-binary.md)).
- **Multi-server:** pick the best node by latency (`url-test`), failover, manual switching.
- **Engine — mihomo:** subscriptions, health-check, hot-reload, SOCKS+HTTP, VLESS Reality — all battle-tested.
- **Multiarch:** `amd64` and `arm64` images, built + published by CI.

## Architecture

```
                     ┌─────────────────────────────────────────┐
 clients / router →  │  mihomo (engine)  ← config.yaml         │
 matter / SOCKS      │     ▲ generated + reloaded via API      │
                     │  submerge (control plane + web UI :3000)│
                     │     │ kind=happ →                       │
                     │     ▼                                   │
                     │  happ-decoder (Happ + Xvfb + mitmproxy) │
                     └─────────────────────────────────────────┘
```

- **submerge** — the application (Node 24 + React SPA in one container): ingest sources → generate `mihomo/config.yaml` → reload mihomo → live node status; serves the web UI and the tRPC/SSE API.
- **happ-decoder** — the official Happ desktop binary as a `happ://` decoder: runs headless (Xvfb) through a local mitmproxy that intercepts the decoded sub-URL. Called by submerge over HTTP, on demand.
- **mihomo** — tunneling and proxy-serving engine.

## Quick start

```bash
git clone https://github.com/gentslava/submerge && cd submerge
docker compose up -d
```

Open **http://127.0.0.1:3000**, paste a subscription / `vless://` / `happ://` — the type
is detected automatically. The proxy is available at `127.0.0.1:7890` (SOCKS5 and HTTP):

```bash
curl --proxy socks5h://127.0.0.1:7890 https://api.ipify.org   # should show the node's IP
```

> The `happ-decoder` image bundles the official Happ desktop + Qt, so it's large (~hundreds of MB) — the first pull takes a moment.

## Configuration

| Variable | Service | Purpose |
|---|---|---|
| `MIHOMO_SECRET` | submerge | mihomo API secret (default `poc` — **change in production**) |
| `HAPP_DECODER_URL` | submerge | address of the happ-decoder service |
| `HAPP_VERSION` | happ-decoder (build-arg) | Happ desktop version (key source) |

**Security:** the proxy and API listen on `127.0.0.1` only. The runtime file
`mihomo/config.yaml` contains your nodes after startup — it is in `.gitignore`;
do not commit it:
`git update-index --skip-worktree mihomo/config.yaml`.

## Roadmap

- [ ] incy subscriptions
- [ ] per-source delete from UI, status indicators / auto-ping
- [ ] selective routing (RU → direct) and tun mode for production
- [ ] move secret/settings to `.env`

## License

[MIT](LICENSE). This project is not affiliated with Happ or mihomo.
