# submerge

Self-hosted VPN subscription aggregator acting as a **client**: accepts subscriptions from multiple
providers (including encrypted `happ://` links), aggregates nodes, and serves a local
SOCKS5/HTTP proxy via the **mihomo** engine — with a web UI for management.

> Designed as a transparent upstream: your router-mihomo (or any client) connects to
> a single local proxy, while submerge manages the provider nodes behind it, picks the
> best one, and keeps subscriptions up to date.

## Features

- **Any node source through a single UI:** `vless://` (ws+tls / tcp+reality+vision / xhttp / grpc), subscriptions (clash-yaml / base64 / v2ray-json), `happ://`.
- **Auto-detection** of the pasted string type.
- **happ:// out of the box** — decoded by the official Happ binary (current keys), not a stale reverse decoder. See [happ-decoder](#happ-how-it-works).
- **Multi-server:** pick the best node by latency (`url-test`), failover, manual switching.
- **Engine — mihomo:** subscriptions, health-check, hot-reload, SOCKS+HTTP, VLESS Reality — all battle-tested.
- **Multiarch:** amd64 and arm64.

## Architecture

```
                     ┌─────────────────────────────────────────┐
 clients / router →  │  mihomo (engine)  ← config.yaml         │
 matter / SOCKS      │     ▲ generated + reloaded via API      │
                     │  combine (control plane + web UI :3000) │
                     │     │ kind=happ →                       │
                     │     ▼                                   │
                     │  happ-decoder (Happ + Xvfb + mitmproxy) │
                     └─────────────────────────────────────────┘
```

- **combine** — Node service: ingest sources → generate `mihomo/config.yaml` → reload mihomo → node status; serves the web UI.
- **happ-decoder** — the official Happ desktop binary as a `happ://` decoder: runs headless (Xvfb) through a local mitmproxy that intercepts the decoded sub-URL. Called by combine over HTTP, on demand.
- **mihomo** — tunneling and proxy-serving engine.

## Quick start

```bash
git clone https://github.com/gentslava/submerge && cd submerge
docker compose up -d --build
```

Open **http://127.0.0.1:3000**, paste a subscription / `vless://` / `happ://` — the type
is detected automatically. The proxy is available at `127.0.0.1:7890` (SOCKS5 and HTTP):

```bash
curl --proxy socks5h://127.0.0.1:7890 https://api.ipify.org   # should show the node's IP
```

> The first build of `happ-decoder` downloads the official Happ desktop (~75 MB) and Qt dependencies — the image is large, this is expected.

## happ:// — how it works

`happ://crypt…` is an encrypted Happ link that wraps a regular subscription URL. The
encryption keys are tied to the app version and **rotate silently**, so static reverse
decoders (LeeeeT et al.) go stale quickly.

submerge uses **the official Happ client itself** as the decoder: the binary has a
dev flag `--test-crypt5` that decodes the link with the current keys and fetches the
subscription; a local mitmproxy intercepts the decoded URL and body. That makes it a
regular subscription consumed by mihomo. **Updating keys = rebuilding the image with
a fresh Happ** (`HAPP_VERSION`), no reverse engineering required.

> **Disclaimer.** This tool is for interoperability — decoding **your own** subscriptions
> on your own server. The Happ binary is downloaded from the official repository at build
> time and is **not included** in this repository; private keys are not extracted or distributed.

## Multiarch build / publish

```bash
docker buildx build --platform linux/amd64,linux/arm64 \
  --build-arg HAPP_VERSION=2.18.3 \
  -t ghcr.io/gentslava/submerge-happ-decoder:latest ./happ-decoder --push

docker buildx build --platform linux/amd64,linux/arm64 \
  -t ghcr.io/gentslava/submerge-combine:latest ./combine --push
```

`happ-decoder` selects the correct Happ `.deb` for the target architecture via `TARGETARCH`.

## Configuration

| Variable | Service | Purpose |
|---|---|---|
| `MIHOMO_SECRET` | combine | mihomo API secret (default `poc` — **change in production**) |
| `HAPP_DECODER_URL` | combine | address of the happ-decoder service |
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
