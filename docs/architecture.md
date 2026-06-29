# Архитектура submerge v2

Обзор для агентов и разработчиков. Полный дизайн — в [docs/specs/2026-06-29-submerge-v2-stack-design.md](specs/2026-06-29-submerge-v2-stack-design.md).

```
┌──────────────── один Docker-контейнер: submerge ────────────────┐
│  web (React SPA)  ──tRPC query/mutation──┐                       │
│      ▲  tRPC subscription (SSE)           ▼                      │
│      └──────────────────────  server (Node 24 + TS)             │
│                               ├─ tRPC router (modules)           │
│                               ├─ Drizzle + SQLite (WAL)          │
│                               ├─ SSE-хаб (опрос mihomo → fan-out)│
│                               └─ clients/ (изолированы, Zod)     │
└───────────────────────────────┬──────────────────┬─────────────┘
                       HTTP ↓ Clash API       HTTP ↓ /decode
                        mihomo (Go)            happ-decoder (Python)
```

## Слои и границы

- **shared** — единственный контракт: Zod-схемы домена (Source, Proxy, Settings) и выведенные типы. Импортируется и server, и web.
- **server** — control-plane. Модули по фичам (`sources`, `nodes`, `settings`, `auth`): `router.ts` (валидация+вызов) + `service.ts` (логика+Drizzle). Внешние сервисы — только через `clients/` (mihomo, happ-decoder) с таймаутами и Zod-валидацией ответов. tRPC отдаёт типы во web без codegen.
- **web** — React SPA. tRPC-клиент + TanStack Query (серверное состояние), uPlot (live-метрики), shadcn/ui.
- **happ-decoder** (Python) и **mihomo** (Go) — внешние процессы, переиспользуются из PoC без изменений.

## Потоки данных

- **Управление** (добавить источник, выбрать узел): web → tRPC mutation → server module → (parse / fetchSubscription / ingestHapp) → генерация config.yaml → reload mihomo.
- **Real-time** (узлы/пинги/трафик): server SSE-хаб опрашивает mihomo → fan-out через tRPC subscription (SSE) → web патчит кэш TanStack Query точечно; высокочастотные метрики идут в uPlot мимо кэша (throttle).
- **Персист**: источники/настройки/HWID/сессии — в SQLite (Drizzle). Узлы не хранятся (живой статус из mihomo); snapshot узлов источника — в `sources.proxies`.

## Ключевые решения

См. [docs/adr/](adr/): happ через официальный бинарь, X-Hwid per-source, выбор стека, анти-оверинжиниринг.
