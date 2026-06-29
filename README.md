# submerge

Self-hosted «комбайн» VPN-подписок для роли **клиента**: принимает подписки разных
провайдеров (включая зашифрованные `happ://`), агрегирует узлы и раздаёт локальный
SOCKS5/HTTP-прокси через движок **mihomo** — с веб-интерфейсом для управления.

> Задумано как невидимый upstream: твой роутер-mihomo (или любой клиент) ходит в
> один локальный прокси, а submerge держит за ним узлы провайдера, выбор лучшего и
> автообновление подписок.

## Возможности

- **Любые источники узлов через один UI:** `vless://` (ws+tls / tcp+reality+vision / xhttp / grpc), подписка (clash-yaml / base64 / v2ray-json), `happ://`.
- **Автоопределение типа** вставленной строки.
- **happ:// «из коробки»** — декодируется официальным бинарём Happ (актуальные ключи), а не отстающим реверс-декодером. См. [happ-decoder](#happ--как-это-работает).
- **Мультисервер:** выбор лучшего узла по задержке (`url-test`), failover, ручное переключение.
- **Движок — mihomo:** подписки, health-check, hot-reload, SOCKS+HTTP, VLESS Reality — всё уже зрелое.
- **Мультиарх:** amd64 и arm64.

## Архитектура

```
                     ┌─────────────────────────────────────────┐
 клиенты / роутер →  │  mihomo (движок)  ← config.yaml          │
 matter / SOCKS      │     ▲ генерит + reload через API         │
                     │  combine (control-plane + веб-UI :3000)  │
                     │     │ kind=happ →                         │
                     │     ▼                                     │
                     │  happ-decoder (Happ + Xvfb + mitmproxy)   │
                     └─────────────────────────────────────────┘
```

- **combine** — Node-сервис: ingest источников → генерация `mihomo/config.yaml` → reload mihomo → статус узлов; отдаёт веб-UI.
- **happ-decoder** — официальный бинарь Happ desktop как декодер `happ://`: запускается headless (Xvfb) через локальный mitmproxy, который перехватывает декодированный sub-URL. Вызывается combine по HTTP, по запросу.
- **mihomo** — движок туннелирования и раздачи прокси.

## Быстрый старт

```bash
git clone https://github.com/gentslava/submerge && cd submerge
docker compose up -d --build
```

Открой **http://127.0.0.1:3000**, вставь подписку / `vless://` / `happ://` — тип
определится сам. Прокси раздаётся на `127.0.0.1:7890` (SOCKS5 и HTTP):

```bash
curl --proxy socks5h://127.0.0.1:7890 https://api.ipify.org   # должен показать IP узла
```

> Первая сборка `happ-decoder` тянет официальный Happ desktop (~75 МБ) и Qt-зависимости — образ крупный, это нормально.

## happ:// — как это работает

`happ://crypt…` — зашифрованная ссылка Happ, внутри которой спрятан обычный
subscription-URL. Ключи шифрования привязаны к версии приложения и **молча
ротируются**, поэтому статические реверс-декодеры (LeeeeT и т.п.) быстро устаревают.

submerge использует **сам официальный клиент Happ** как декодер: бинарь имеет
dev-флаг `--test-crypt5`, декодирует ссылку актуальными ключами и запрашивает
подписку; локальный mitmproxy перехватывает декодированный URL и тело. Дальше это
обычная подписка, которую тянет mihomo. **Обновление ключей = пересборка образа со
свежим Happ** (`HAPP_VERSION`), реверс не требуется.

> **Disclaimer.** Инструмент предназначен для совместимости (interoperability) —
> декодирования **собственных** подписок пользователя на его сервере. Бинарь Happ
> скачивается с официального репозитория при сборке и **не включён** в этот
> репозиторий; приватные ключи не извлекаются и не распространяются.

## Мультиархитектурная сборка / публикация

```bash
docker buildx build --platform linux/amd64,linux/arm64 \
  --build-arg HAPP_VERSION=2.18.3 \
  -t ghcr.io/gentslava/submerge-happ-decoder:latest ./happ-decoder --push

docker buildx build --platform linux/amd64,linux/arm64 \
  -t ghcr.io/gentslava/submerge-combine:latest ./combine --push
```

`happ-decoder` сам выбирает `.deb` Happ под целевую архитектуру по `TARGETARCH`.

## Конфигурация

| Переменная | Сервис | Назначение |
|---|---|---|
| `MIHOMO_SECRET` | combine | secret mihomo API (по умолчанию `poc` — **смени в проде**) |
| `HAPP_DECODER_URL` | combine | адрес сервиса happ-decoder |
| `HAPP_VERSION` | happ-decoder (build-arg) | версия Happ desktop (источник ключей) |

**Безопасность:** прокси и API слушают только `127.0.0.1`. Рантайм-файл
`mihomo/config.yaml` после запуска содержит твои узлы — он в `.gitignore` по
части артефактов; сам конфиг не коммить:
`git update-index --skip-worktree mihomo/config.yaml`.

## Дорожная карта

- [ ] incy-подписки
- [ ] удаление отдельных источников из UI, статусы/авто-пинг
- [ ] селективный роутинг (RU → direct) и tun-режим для прода
- [ ] вынос secret/настроек в `.env`

## Лицензия

[MIT](LICENSE). Проект не аффилирован с Happ или mihomo.
