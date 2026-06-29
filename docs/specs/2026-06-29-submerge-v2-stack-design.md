# submerge v2 — дизайн нового стека

- **Дата:** 2026-06-29
- **Статус:** утверждён к реализации
- **Контекст:** переписывание PoC (`combine` на голом Node + vanilla JS + один HTML) в production-grade self-hosted приложение.

## 1. Цель и принципы

Превратить рабочий PoC submerge в качественное, быстрое, красивое и **поддерживаемое** self-hosted приложение для управления VPN-подписками, не потеряв отлаженную логику ingest/happ/HWID.

Принципы:
- **No legacy на старте:** Node 24 LTS + все зависимости последних мажорных версий, зафиксированы в `pnpm-lock`.
- **Анти-оверинжиниринг:** минимально достаточная сложность для масштаба «один админ, десятки источников, сотни узлов». Никаких Postgres/GraphQL/Nx/hexagonal/DI/OTel.
- **Жёсткие границы только там, где окупаются:** изоляция внешних сервисов (mihomo, happ-decoder) с Zod-валидацией ответов — главная точка отказа.
- **End-to-end типобезопасность** через tRPC + общие Zod-схемы.

Масштаб: **self-hosted продукт**, single-admin (опц. пароль), БД-персист, публикуемый на GitHub (каждый разворачивает свой инстанс).

## 2. Стек

**Общая платформа:** Node **24 LTS**, TypeScript (strict), pnpm workspaces, Biome (lint+format), Vitest + Playwright.

**server:** tRPC v11 · Drizzle ORM + SQLite (better-sqlite3, WAL) · Zod 4 · pino · сессия-auth (@node-rs/argon2) · SSE-хаб для real-time.

**web:** Vite · React 19 · shadcn/ui (Radix) · Tailwind CSS v4 · TanStack Query v5 · TanStack Router v1 · react-hook-form + Zod · uPlot (live-графики) · lucide-react · sonner · тёмная тема.

**Деплой:** Docker multi-stage (node:24-bookworm → slim, non-root), multiarch (amd64/arm64) buildx, один образ `ghcr.io/gentslava/submerge`. GitHub Actions CI.

Все версии — latest-мажор на момент установки; обновления через pnpm, не пиним устаревшее.

## 3. Архитектура

```
┌──────────────── один Docker-контейнер: submerge ────────────────┐
│  web (React SPA, статика)  ──tRPC query/mutation──┐              │
│      ▲  tRPC subscription (SSE, real-time)         ▼             │
│      └────────────────────────────────  server (Node 24 + TS)   │
│                                          ├─ tRPC router (modules)│
│                                          ├─ Drizzle + SQLite WAL │
│                                          ├─ SSE-хаб (mihomo→fan) │
│                                          └─ clients/ (изолир.)   │
└───────────────────────────────┬──────────────────┬─────────────┘
                       HTTP ↓ Clash API       HTTP ↓ /decode
                        mihomo (Go)            happ-decoder (Python)
```

Один контейнер раздаёт статику web + `/trpc` (query/mutation + SSE-subscription). Рядом в `docker-compose` — `mihomo` и `happ-decoder` (без изменений). Всё общение с ними — только через `server/clients/*` (таймауты, ретраи, Zod-парсинг ответов).

## 4. Структура монорепо (pnpm workspaces)

```
submerge/
├─ packages/
│  ├─ shared/    # Zod-схемы домена + z.infer типы — единый контракт фронт↔бэк
│  ├─ server/
│  │  └─ src/
│  │     ├─ db/         # drizzle schema, connection (WAL pragma), migrations/
│  │     ├─ trpc/       # init, context, procedure/middleware (auth, logging)
│  │     ├─ modules/    # sources/ nodes/ settings/ auth/ — router.ts + service.ts
│  │     ├─ clients/    # mihomo.ts, happDecoder.ts (HTTP + Zod-валидация)
│  │     ├─ sse/        # SSE-хаб: опрос mihomo, fan-out
│  │     ├─ config/     # env.ts (Zod fail-fast при старте)
│  │     └─ index.ts    # HTTP-сервер: статика web + /trpc + /sse + /healthz
│  └─ web/
│     └─ src/{routes, components/ui (shadcn), features, lib (trpc/query), hooks}
├─ happ-decoder/        # как есть (Python)
├─ mihomo/              # стартовый config.yaml
├─ docker-compose.yml  Dockerfile  .github/workflows/ci.yml
└─ docs/specs/
```

Модуль server = тонкий `router.ts` (валидация + вызов) + `service.ts` (логика + Drizzle-запросы напрямую, без репозиториев). `AppRouter`-тип экспортируется из server, импортируется в web как type-only.

## 5. Модель данных (SQLite + Drizzle)

- **`sources`**: `id, kind('sub'|'vless'|'happ'), value, label, hwid(bool, default false), enabled(bool, default true), sort_order, proxies(json snapshot), updated_at, created_at`
- **`settings`**: key-value (тема, mihomo secret, интервалы опроса, RU-direct роутинг on/off)
- **`sessions`**: `id, expires_at` (для опц. auth)

Узлы не хранятся отдельно: живой статус — из mihomo; `sources.proxies` хранит snapshot для генерации конфига без повторного fetch (+ ручной «обновить»). Драйвер на старте: `PRAGMA journal_mode=WAL; foreign_keys=ON; busy_timeout=5000`. Бэкап — `VACUUM INTO` по расписанию в volume.

## 6. API-контракт (tRPC)

Роутеры:
- **`sources`**: `list`, `add(value, hwid?)`, `remove(id)`, `refresh(id)`, `toggle(id)`, `reorder(ids)`
- **`nodes`**: `list` (группа PROXY из mihomo), `delay(name)`, `select(group, name)`
- **`settings`**: `get`, `set`
- **`auth`**: `login(password)`, `logout`, `me`
- **`live`** (subscription, tRPC over SSE): стрим `nodeUpdate / traffic / delay`

Инпуты/аутпуты — Zod-схемы из `shared`; фронт получает типы через инференс tRPC (без codegen). Внешние HTTP-ответы (mihomo/happ) обязательно `Zod.parse()`.

## 7. Real-time data-flow

server держит один **SSE-хаб**: периодически опрашивает mihomo (`/proxies`, `/connections`) → нормализует → fan-out подписчикам tRPC `live`. web: subscription → `queryClient.setQueryData` точечным патчем узла по имени (без перерисовки таблицы). Высокочастотные трафик/пинги — буфер (throttle ~300мс) прямо в uPlot, мимо кэша Query. Состояние — в памяти процесса (один админ; Redis не нужен). Окно метрик ограничено (windowing) во избежание утечки при долгом аптайме.

## 8. Перенос логики PoC (ничего не теряем)

Из текущего `combine` переезжает в `server` с покрытием тестами:
- `modules/sources`: `detectKind`, `parseVless`, `parseProxiesFromText` (clash-yaml / v2ray-vnext / sing-box / base64), `extractSubUrl` (клиентские deep-links: incy/clash/sing-box/happ-add/…), `fetchSubscription(url, useHwid)` (per-source `X-Hwid` + `X-Device-Os`).
- `modules/nodes`: генерация `config.yaml` (mixed-port, PROXY select + AUTO url-test, правила) + reload mihomo.
- `clients/happDecoder`: `ingestHapp(link, hwid)` → POST `/decode {link, hwid}` (decoder сам инжектит X-Hwid через mitmproxy).
- `clients/mihomo`: reload / proxies / select / delay.
- `shared`: Zod-схемы proxy/source/настроек.

HWID: стабильный, общий (как в PoC `hwid.txt` или строка настроек в БД), per-source флаг, по умолчанию выключен. happ-decoder и mihomo — без изменений.

## 9. Auth

Single-admin: пароль из env (Argon2id-хэш), при логине httpOnly+Secure+SameSite=Lax cookie с подписанным session-id, сессии в SQLite (logout/revoke, переживают рестарт). Rate-limit на login (in-memory). **По умолчанию выключен** (если пароль не задан в env — UI открыт; задан — требует вход). ~100 строк, без внешней auth-библиотеки.

## 10. Деплой и тесты

- **Dockerfile**: builder `node:24-bookworm` (pnpm install, компиляция better-sqlite3, сборка web+server) → runtime `node:24-bookworm-slim` (prod-зависимости + dist + статика, non-root). pnpm `deploy --filter`. Не distroless (нативный модуль).
- **Multiarch**: buildx amd64+arm64, нативные arm64-раннеры в CI, smoke-тест на каждой арке.
- **CI** (GitHub Actions): `biome ci` → `tsc --noEmit` → `vitest run` → (Playwright на main) → buildx push в GHCR.
- **Тесты**: Vitest — unit на парсеры/ingest (перенос проверок PoC в кейсы) + integration с SQLite `:memory:`; Playwright — критичные пути (логин, добавить источник, выбрать узел). strict TS (`noUncheckedIndexedAccess` и пр.).
- **Observability**: pino (request-id, отдельный лог исходящих к mihomo/happ с латентностью), `/healthz` + `/readyz`, graceful shutdown (SIGTERM → close server + db).

## 11. Этапность

PoC в `~/Developer/submerge` остаётся рабочим. v2 строим в этом же репо (структура монорепо), happ-decoder переиспользуем как есть. Переключаем `docker-compose` на новый `submerge`-сервис, когда v2 проходит smoke. Старый `combine` удаляем после переключения.

## 12. Вне scope (YAGNI)

Мультитенантность/роли, OAuth/2FA, Postgres, GraphQL, Nx/Turborepo, hexagonal/CQRS, OpenTelemetry/Prometheus, мобильное приложение. Может вернуться позже как отдельные спеки: incy-специфичные форматы (если появятся), RU-direct/tun-режим роутинга для прода, метрики.
