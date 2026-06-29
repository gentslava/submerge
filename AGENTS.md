# AGENTS.md — submerge

Инструкции для ИИ-агентов, работающих над проектом. Читается Claude Code, Cursor, Copilot и др. Вложенные `AGENTS.md` в пакетах переопределяют этот для своей области.

## Что это за проект

**submerge** — self-hosted веб-приложение для управления VPN-подписками (роль клиента). Принимает источники узлов (URL подписок, `vless://`, `happ://`, клиентские deep-links), парсит узлы, генерирует конфиг для движка **mihomo** (Clash) и управляет им по REST API, показывает узлы с пингами/трафиком в реальном времени, позволяет выбирать активный узел и раздаёт локальный SOCKS/HTTP-прокси.

Аудитория: **self-hosted продукт**, single-admin (опц. пароль), разворачивается через docker compose.

## Статус репозитория (важно)

- **PoC (рабочий):** `combine/` (Node + vanilla JS), `happ-decoder/` (Python), `mihomo/`, корневой `docker-compose.yml`. **Не трогать до Фазы 6** — это эталон поведения.
- **v2 (в разработке):** `packages/` — переписывание на современный стек. Спека: [docs/specs/2026-06-29-submerge-v2-stack-design.md](docs/specs/2026-06-29-submerge-v2-stack-design.md). Планы: `docs/plans/`.

## Стек (v2)

Node **24 LTS**, TypeScript strict, pnpm workspaces, Biome, Vitest/Playwright.
- **server**: tRPC v11 · Drizzle ORM + SQLite (better-sqlite3, WAL) · Zod 4 · pino · сессия-auth (@node-rs/argon2) · SSE-хаб.
- **web**: Vite · React 19 · shadcn/ui · Tailwind v4 · TanStack Query/Router · uPlot · lucide-react · sonner.
- **shared**: Zod-схемы домена + выведенные типы (единый контракт).

Все зависимости — последних мажорных версий, пиннинг через `pnpm-lock.yaml`. **No legacy на старте.**

## Структура (целевая, v2)

```
packages/shared/   # Zod-схемы + типы — контракт фронт↔бэк
packages/server/   # tRPC, Drizzle, SSE, clients/ (mihomo, happ-decoder), modules/ (sources,nodes,settings,auth)
packages/web/      # React SPA
docs/{specs,plans,adr,architecture.md}
```

server-модуль = `router.ts` (тонкий: валидация+вызов) + `service.ts` (логика+Drizzle напрямую). Без репозиториев/DI.

## Команды (v2)

```bash
pnpm install              # установка
pnpm -F @submerge/server dev      # dev-сервер
pnpm test                # все тесты (vitest)
pnpm typecheck           # tsc -b --noEmit
pnpm lint                # biome ci .
pnpm format              # biome format --write .
pnpm -F @submerge/server db:generate   # сгенерировать миграцию из схемы
```

PoC: `docker compose up -d` (combine+mihomo+happ-decoder).

## Конвенции

- **TS strict** (+ `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`). ESM, `verbatimModuleSyntax`.
- **Форматирование/линт — Biome** (не ESLint/Prettier). Прогонять перед коммитом.
- **Валидация:** Zod на границах. **Ответы внешних сервисов (mihomo, happ-decoder) ОБЯЗАТЕЛЬНО `.parse()`** — это главная точка отказа.
- **Границы:** вся работа с mihomo/happ-decoder — только через `packages/server/src/clients/*` (таймауты, ретраи, Zod). Не дёргать их HTTP напрямую из модулей.
- **Именование:** camelCase (TS), kebab-case (файлы), таблицы/колонки snake_case (Drizzle mapping в schema.ts).
- **Анти-оверинжиниринг:** для масштаба «один админ, десятки источников, сотни узлов» НЕ вводить Postgres, GraphQL, Nx/Turborepo, hexagonal/CQRS/DI, OpenTelemetry. См. ADR.

## Workflow

- **TDD**: сначала падающий тест, потом минимальная реализация. Логику парсинга/ingest покрывать unit-тестами.
- **Частые атомарные коммиты**, conventional commits (`feat:`, `fix:`, `chore:`, `docs:`). Завершать тело строкой:
  `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`
- **Гейты перед коммитом:** `pnpm lint && pnpm typecheck && pnpm test` — зелёные.
- Перед использованием библиотек сверяться с актуальным API через **Context7 MCP** (Zod 4, tRPC v11, Drizzle, React 19) — версии latest, API мог измениться.

## Чего не делать

- Не трогать PoC (`combine/`, `happ-decoder/`, `mihomo/`, корневой compose) до Фазы 6.
- Не пинить устаревшие версии «для совместимости» — берём latest.
- Не коммитить секреты/рантайм: `mihomo/config.yaml` (узлы), `*/sources.json`, `hwid.txt`, `.env`, `data/*.db` — в `.gitignore`.
- Не переусложнять (см. ADR-0004).

## Доменные факты (не переоткрывать)

- **happ://crypt** декодируется официальным бинарём Happ (Qt) в sidecar `happ-decoder` (Xvfb + mitmproxy перехватывает декодированный sub-URL). Статические реверс-декодеры (LeeeeT) устаревают из-за ротации ключей — см. ADR-0001.
- **X-Hwid** — per-source флаг (по умолчанию выкл): провайдеры с привязкой к устройству без него отдают заглушку. Для https-подписок шлёт combine, для happ — mitmproxy инжектит. См. ADR-0002.
- Форматы подписок: clash-yaml, base64-vless, v2ray/sing-box JSON. Deep-links клиентов (incy/clash/sing-box/…) — обёртка над URL, извлекается `extractSubUrl`.
- mihomo — движок туннелирования (Go), управляется по Clash REST API.

## Карта документации

- `docs/specs/` — спецификации (что строим).
- `docs/plans/` — планы реализации по фазам (как строим, bite-sized задачи).
- `docs/adr/` — принятые архитектурные решения и почему.
- `docs/architecture.md` — обзор архитектуры v2.
