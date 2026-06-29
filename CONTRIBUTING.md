# Contributing

Гайд для разработчиков и ИИ-агентов. Подробные правила для агентов — в [AGENTS.md](AGENTS.md).

## Требования

- Node **24 LTS**, pnpm, Docker (для happ-decoder/mihomo и сборки).

## Старт (v2)

```bash
pnpm install
pnpm -F @submerge/server db:generate   # миграции из схемы (при изменении db/schema.ts)
pnpm -F @submerge/server dev           # dev-сервер
pnpm test                              # тесты
```

## Рабочий цикл

1. Берём задачу из плана (`docs/plans/`) — реализация идёт по фазам.
2. **TDD**: падающий тест → минимальная реализация → зелёный тест.
3. Перед коммитом — гейты: `pnpm lint && pnpm typecheck && pnpm test`.
4. Атомарные коммиты, conventional commits (`feat:`/`fix:`/`docs:`/`chore:`).
5. Значимое архитектурное решение → ADR в `docs/adr/`.

## Границы

- Внешние сервисы (mihomo, happ-decoder) — только через `packages/server/src/clients/*`.
- Ответы внешних сервисов валидировать через Zod.
- Не трогать PoC (`combine/`, `happ-decoder/`, `mihomo/`, корневой `docker-compose.yml`) до Фазы 6.

## Документация

- `docs/specs/` — что строим · `docs/plans/` — как · `docs/adr/` — почему · `docs/architecture.md` — обзор.
