# `extension/src/workspace` — WorkspaceResolver

Компонент, который по открытой папке говорит, какой это воркспейс и как опознать
его между запусками. Реализация — [resolver.ts](resolver.ts); модель воркспейса
описана в §4 [SPECIFICATION.md](../../../SPECIFICATION.md).

Модуль не импортирует `vscode`: на вход приходят папки в форме
`vscode.WorkspaceFolder` (`uri.fsPath`, `name`, `index`), remote — строкой.
Поэтому его можно покрыть unit-тестами на временных каталогах
([tests/workspace-resolver.test.mjs](../../../tests/workspace-resolver.test.mjs)).

## Публичный API

### `resolveWorkspace(folders, options?) → Promise<ResolvedWorkspace | null>`

Определяет воркспейс по открытым папкам. `null` — если ни одна папка не открыта.

```ts
import { resolveWorkspace } from './workspace/resolver';

const workspace = await resolveWorkspace(vscode.workspace.workspaceFolders ?? [], {
  remoteName: vscode.env.remoteName,
  workspaceFile: vscode.workspace.workspaceFile?.fsPath
});
```

Возвращает:

| Поле | Тип | Что это |
|---|---|---|
| `id` | `string` | `sha256[:16]` от ключа воркспейса |
| `path` | `string` | канонический путь primary-папки |
| `name` | `string` | имя primary-папки (для UI, в ключ не входит) |
| `remote` | `string` | remote-хост: `local`, `ssh`, `wsl`, `containers`… |
| `gitRemote` | `string \| null` | `host/org/repo` из `remote.origin.url` |
| `multiRoot` | `boolean` | открыто больше одной папки |
| `primary` | `ResolvedWorkspaceFolder` | первая папка (`path`, `name`, `index`) |
| `folders` | `ResolvedWorkspaceFolder[]` | все папки после канонизации |
| `codeWorkspaceFile` | `string \| null` | путь к `.code-workspace`, если открыт он |

### Ключ и `id`

```
id = sha256("remote | канонический путь | gitRemote")[:16]
```

Путь входит в ключ **всегда** (решение оркестратора от 2026-11-09, §4.1
спецификации): две папки одного репозитория (`repo/frontend` и `repo/backend`) —
разные воркспейсы, а переезд папки создаёт новую запись реестра. `gitRemote`
остаётся дополнительным признаком проекта (для UI и реестра), но не заменяет
путь: иначе две открытые папки одного репозитория перезаписывали бы запись друг
друга в реестре `~/.dsh/workspaces/<id>.json`.

Канонический путь: `fs.realpath` (симлинки), NFC-нормализация Unicode, без
хвостового разделителя. В ключе путь дополнительно приводится к нижнему регистру
на `darwin`/`win32` (регистронезависимые файловые системы). Имя папки в ключ не
входит.

### `normalizeGitRemote(url) → string | null`

Приводит URL remote к `host/org/repo`:

| Вход | Выход |
|---|---|
| `git@github.com:acme/api-service.git` | `github.com/acme/api-service` |
| `ssh://git@github.com:22/acme/api-service.git` | `github.com/acme/api-service` |
| `https://user:token@gitlab.example.com/group/sub/repo.git` | `gitlab.example.com/group/sub/repo` |
| `/srv/git/repo.git`, `file:///srv/git/repo.git` | `null` |

Токены и логины из URL отбрасываются: `gitRemote` попадает в ключ и реестр, а
секреты в реестр не пишутся (§8).

### `parseGitConfigRemoteUrl(configText) → string | null`

Разбирает текст `.git/config`: берёт `remote.origin.url`, иначе URL первого
remote. Понимает кавычки и комментарии. INI разбирается вручную — внешних
зависимостей нет.

### `readGitRemote(directory) → Promise<string | null>`

Ищет `.git` вверх по дереву (вложенные папки внутри репозитория) и читает remote:
- `.git` — каталог: `<repo>/.git/config`;
- `.git` — файл (`git worktree`, сабмодуль): `gitdir: <путь>`, дальше `commondir`
  (общий конфиг) или конфиг самого gitdir.

`child_process` не используется: на горячем пути только чтение файлов.

### Вспомогательные экспорты

- `workspaceId(remote, canonicalPath, gitRemote, platform?)` — тот же хеш, что
  использует `resolveWorkspace` (например, чтобы пересчитать `id` для записи из
  реестра).
- `canonicalizePath(path, platform?)` — `realpath` + NFC + без хвостового
  разделителя; несуществующий путь не роняет резолв.
- `normalizePathForKey(path, platform?)` — нормализация пути для ключа.
- `normalizeRemoteName(remoteName?)` — `undefined`/пусто → `local`.
- `LOCAL_REMOTE` — константа `'local'`.

## Границы

- Модуль только читает файловую систему и ничего не пишет.
- Реестр (`~/.dsh/workspaces/<id>.json`) и жизненный цикл воркспейса — задачи
  #003 и #011; здесь только идентичность.
- Манифест `.dsh/workspace.json` — задача #006 (`ContextLoader`).

## Lifecycle смены папки (#011)

`lifecycle.ts` — машина состояний `resolving → loading-context → ready →
paused → teardown` и grace period:

- `activate(folder)` — создаёт рантайм (мост DSH, менеджер сессий, загрузчик
  контекста), грузит контекст #006 и восстанавливает последнюю сессию #007;
- при переключении A→B сессия A ставится на паузу и остаётся живой
  `dsh.workspace.graceMinutes` минут (по умолчанию 10); возврат в A в этом окне
  — `resume()` без перезапуска процесса, по истечении — `dispose()` и GC;
- `handleWorkspaceFolders(folders)` — debounce событий смены папок, пустой
  список деактивирует воркспейс;
- `acceptsEvent(workspaceId)` — события старого воркспейса отбрасываются по id;
- публичные операции сериализуются, поэтому быстрые A→B→A не создают гонок;
- `graceMsFromMinutes(value)` — разбор настройки (мусор → 10 минут).

`lifecycleController.ts` — VS Code-обвязка: `onDidChangeWorkspaceFolders`,
резолв #002, реальные рантаймы, статус-бар; подключается в `activate()`.

Тесты — `tests/workspace-lifecycle.test.mjs` (fake timers): A→B→A, teardown по
таймеру, возврат в пределах grace, debounce, пустой список, отбрасывание
событий старого воркспейса, ошибка создания рантайма, `teardownAll`, состояние
и настройка grace.
