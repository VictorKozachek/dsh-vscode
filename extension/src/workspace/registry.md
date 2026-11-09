# `extension/src/workspace/registry.ts` — реестр воркспейсов

Локальный реестр воркспейсов: одна запись — один JSON-файл
`<registryPath>/<id>.json` со схемой из §4.2
[SPECIFICATION.md](../../../SPECIFICATION.md). Реестр переживает рестарты IDE,
не хранит секретов и чистится по сроку давности.

## Схема файла

```jsonc
{
  "version": 2,                       // версия схемы, миграции — при чтении
  "id": "a1b2c3d4e5f60718",           // 16 hex, из WorkspaceResolver
  "path": "/Users/victor/projects/api-service",
  "remote": "local",                  // local | ssh | wsl | containers …
  "gitRemote": "github.com/acme/api-service",
  "name": "api-service",
  "lastOpenedAt": "2026-11-09T15:40:00.000Z",
  "lastSessionId": "sess_01J…",
  "defaultModel": "deepseek-chat",
  "sandboxMode": "workspace-write",
  "approvalPolicy": "ask",
  "contextSnapshot": { "hash": "sha256:…", "skills": ["kanban"], "rules": ["AGENTS.md"], "files": 1287 }
}
```

Версия схемы — `REGISTRY_SCHEMA_VERSION` (сейчас `2`). Файл без `version`
считается v1 и мигрирует при чтении: `lastOpenedAt` из миллисекунд в ISO,
`remote` — `local`, `gitRemote`/`contextSnapshot` — `null`.

## API

```ts
import { WorkspaceRegistry } from './workspace/registry';

const registry = new WorkspaceRegistry({
  registryDir: '~/.dsh/workspaces', // dsh.workspace.registryPath, ~ раскрывается
  keepDays: 90                      // dsh.workspace.keepDays
});

await registry.save({ id, path, remote: 'ssh', gitRemote: 'github.com/acme/api-service' });
const record = await registry.read(id);       // null — нет/битый/новее схема
await registry.remember({ id, path, name });  // upsert с сохранением полей
await registry.touch(id);                     // обновить lastOpenedAt
await registry.list();                        // свежие сверху
await registry.prune();                       // GC по keepDays → удалённые id
await registry.remove(id);                    // true, если запись была
```

| Метод | Поведение |
|---|---|
| `read(id)` | `null`, если файла нет; битый JSON или не по схеме — файл уходит в `<id>.json.corrupt-<ts>`, возвращается `null`; файл более новой версии схемы не читается и не трогается |
| `save(input)` | атомарно: временный файл `.‹id›.json.tmp-‹pid›-‹n›-‹rand›` + `rename`, права `0600` |
| `remember(input)` | как `save`, но сохраняет поля прошлой записи |
| `prune(keepDays?)` | удаляет записи, не открывавшиеся дольше срока (и с нечитаемой датой); возвращает отсортированные `id` |
| `list()` | читаемые записи, сортировка по `lastOpenedAt` по убыванию |

Ошибки — `WorkspaceRegistryError` с понятным сообщением: нет прав на запись,
некорректный `id` (защита от выхода за пределы каталога), некорректный срок GC.
Процесс не падает.

## Секреты

Ключи, подходящие под `/(token|secret|passw(or)?d|api[-_]?key|auth|credential|private[-_]?key)/i`,
вырезаются рекурсивно из любого значения (включая поле `contextSnapshot`), а из
строк вычищаются креденшелы `https://user:token@host` → `https://host`. Неизвестные
поля верхнего уровня в файл не пишутся вовсе.

## Команда

`DSH: Prune Workspaces` (`dsh.pruneWorkspaces`) — зарегистрирована в
`extension/src/extension.ts`, читает `dsh.workspace.registryPath` и
`dsh.workspace.keepDays`, показывает результат в уведомлении, список удалённых
id — в канал вывода `DSH`.

## Границы

- Резолв воркспейса и `id` — `resolver.ts` (#002); здесь только хранение.
- Жизненный цикл (`resolved → loading-context → ready → paused → teardown`) и
  подстановка `lastSessionId` — #011; контекст-снимок наполняет #006.
