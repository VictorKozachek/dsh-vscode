# План проекта DSH for VS Code

План исполнения спецификации [SPECIFICATION.md](SPECIFICATION.md): этапы, нарезка
на задачи и порядок выдачи. Спека доски с теми же требованиями —
[.kanban/specs/001.md](.kanban/specs/001.md). Доска — `.kanban/tasks/`.

## Текущее состояние

- [x] Спецификация (370 строк): архитектура, модель воркспейса, дизайн панели, этапы M0–M3.
- [x] Два README (EN / RU), репозиторий на GitHub, `origin` = `VictorKozachek/dsh-vscode`.
- [x] Протокол доски в проекте: `bin/`, `.kanban/`, `.agents/skills/`, `AGENTS.md`, `KANBAN.md`.
- [x] Спека нарезки — `.kanban/specs/001.md`.
- [x] Доска подключена к watcher'у плагина (`boards` в `~/.dsh/cordis.patch.yml`);
      наряды доставляются (`.kanban/.watcher-state.json`).
- [x] Задачи нарезаны в `backlog` (#001–#017) и первые выданы исполнителю (#001–#003 в `todo`).

## Роли и сессии

| Роль | Сессия | Где работает |
|---|---|---|
| Оркестратор | `session-8c7ec9a5-e2d6-41c0-adda-faa10d4e6dde` | основной чекаут |
| Исполнитель | `session-93db5d00-8999-4ddd-9454-714f8dd85042` | worktree задачи |
| Ревьювер | `session-e98913c5-73d4-4384-b3cc-a4005041ef1e` | worktree задачи, чтение |
| Тестировщик | `session-680c7af7-1dd1-4eac-80a1-bdcfe599f1ec` | worktree задачи, чтение |

Карта ролей — `.kanban/.watcher-roles.json`, пул исполнителей —
`.kanban/.workers.json` (оба в `.gitignore`).

## Нарезка задач

Порядок выдачи — FIFO по `id`. Один исполнитель держит одну карточку в
`in-progress`; в сумме `in-progress + in-review + testing` — не больше трёх.

| # | Задача | Зависит | Скоуп (файлы) |
|---|---|---|---|
| 001 | Каркас монорепозитория и сборки | — | `package.json`, `tsconfig.base.json`, `extension/`, `webview/`, `protocol/`, `.gitignore` |
| 002 | WorkspaceResolver | 001 | `extension/src/workspace/` |
| 003 | WorkspaceRegistry | 001 | `extension/src/workspace/registry*` |
| 004 | DshBridge: JSON-RPC stdio и supervisor | 001 | `extension/src/bridge/`, `protocol/` |
| 005 | Панель DSH: контейнер и WebView чата | 001 | `webview/`, `extension/src/views/` |
| 006 | ContextLoader | 002, 003 | `extension/src/context/` |
| 007 | SessionManager | 004 | `extension/src/sessions/` |
| 008 | Потоковый чат и tool-call блоки | 004, 005 | `webview/src/chat/`, `extension/src/views/chat*` |
| 009 | Approvals и sandbox-политики | 008 | `extension/src/approvals/`, `webview/src/approvals/` |
| 010 | DiffService: предпросмотр правок | 008 | `extension/src/diff/` |
| 011 | Смена папки и lifecycle процессов | 002, 003, 007 | `extension/src/workspace/lifecycle*` |
| 012 | Multi-root и remote-сценарии | 011 | `extension/src/workspace/remote*`, `multiroot*` |
| 013 | Инспектор контекста и настройки | 006 | `extension/src/views/context*`, `webview/src/context/` |
| 014 | Kanban-панель расширения | 005 | `extension/src/views/kanban*`, `webview/src/kanban/` |
| 015 | Терминал-мост и диагностика | 004 | `extension/src/terminal/`, `extension/src/diagnostics/` |
| 016 | Визуализация субагентов | 008 | `webview/src/subagents/`, `extension/src/views/subagents*` |
| 017 | VSIX, CI и документация | 001–016 | `.github/workflows/`, `docs/`, `extension/package.json` (VSIX) |

## Критерии готовности задачи (Definition of Done)

1. Критерии из карточки выполнены, код собирается (`pnpm build`) и тесты
   проходят в worktree задачи.
2. Правки закоммичены в ветку `task/<id>`; общие файлы не тронуты без согласования
   с оркестратором.
3. Карточка переведена в `in-review` с `note`: что сделано и как проверять.
4. Ревьювер принял (`testing`), тестировщик проверил (`ready`).
5. Оркестратор слил ветку через `bin/task-commit.sh` и удалил worktree.

## Журнал

| Дата | Событие |
|---|---|
| 2026-11-09 | Каркас доски в проекте, спека 001, нарезка #001–#017, доска зарегистрирована в cordis.patch.yml, выданы #001–#003 |
| 2026-11-09 | #001 слита (`bin/task-commit.sh`, `[001] Каркас монорепозитория`), worktree удалён; `main` влит во все task-ветки #002–#017 — снят системный блокер «worktree без каркаса» |
| 2026-11-09 | `minTodo` временно 0 на время ожидания слияния #001, возвращён 1 |
| 2026-11-09 | Интеграционная правка оркестратора: `pnpm test` → `node --test tests/*.test.mjs`, иначе прогон на `main` подхватывает тесты из `worktrees/*` |
| 2026-11-09 | Слиты #001–#005 (каркас, resolver, registry, DshBridge, панель); после каждого слияния `pnpm test` на `main` зелёный |
| 2026-11-09 | Долги из приёмки заведены в backlog: #018 (реестр поверх новой схемы), #019 (percent-encoding в git remote) |

## Порядок работы

1. Оркестратор держит `todo` не ниже `minTodo = 1` (один исполнитель: одна карточка ждёт следующего слота, асайн занятому `backlog-fill` не делает): выдаёт карточки из `backlog`
   по возрастанию `id` (`bin/task-move.sh <id> todo --owner <worker>`).
2. Исполнитель берёт закреплённую карточку, работает в `worktrees/<id>`, отдаёт
   в `in-review`.
3. Ревьювер: `in-review` → `testing` или возврат в `in-progress` с замечаниями.
4. Тестировщик: `testing` → `ready` или возврат с шагами воспроизведения.
5. Оркестратор сливает `ready` по одной ветке, гоняя тесты на `main`, и удаляет
   worktree. Пуш в `origin` — шаг человека, после того как все задачи слиты.

## Риски и решения

| Риск | Решение |
|---|---|
| Watcher не видит доску до перезапуска DSH | `boards` добавлен в `~/.dsh/cordis.patch.yml`; при отсутствии нарядов — перезапуск профиля |
| Ветки, созданные заранее, отстают от `main` | исполнитель перед началом делает `git merge main` в своём worktree; конфликт в общих файлах развязывает оркестратор |
| 17 worktree сразу | каталог `worktrees/` в `.gitignore`; после слияния каждой ветки оркестратор удаляет дерево |
| Конфликты в общих файлах (`package.json` и т. п.) | меняет только оркестратор; исполнитель возвращает карточку с запросом |
