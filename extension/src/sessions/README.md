# `extension/src/sessions` — SessionManager

Жизненный цикл сессий DSH из расширения: create/resume/list/pause через мост
(#004), восстановление после рестарта Extension Host, активная сессия в реестре
(#003), черновики в `workspaceState`, события для статус-бара и панели.

Модуль не импортирует `vscode`: мост и хранилища подключаются узкими портами, а
`DshBridge` подходит структурно. Проводка — в активации расширения (#011),
тесты — `tests/session-manager.test.mjs` (мок-мост, мок-хранилища).

## API

```ts
const manager = new SessionManager({
  workspaceId: workspace.id,
  bridge: dshBridge,                       // DshBridgePort (структурно = DshBridge)
  storage: context.workspaceState,         // MementoPort
  persistence: createRegistrySessionPersistence({ registry, workspacePath }),
  logger: (line) => output.appendLine(line)
});

await manager.restore();                   // при активации: resume последней сессии
await manager.create();                    // DSH: New Session
await manager.resume(sessionId);           // возобновление конкретной сессии
await manager.list();                      // session.list
await manager.startTurn('вопрос');         // turn.start (панель #008)
await manager.stop();                      // DSH: Stop Agent → turn.cancel, сессия остаётся
manager.on('sessionChanged', render);
manager.on('statusChanged', render);
```

| Метод | Поведение |
|---|---|
| `restore()` | если сессия уже активна — возвращает снимок (без дублей); иначе `session.resume` последней из реестра. Новая сессия создаётся только если DSH её не знает (`session.list`): временная ошибка (таймаут/обрыв) и недоступность моста пробрасываются, а не превращаются в дубль |
| `create()` | `session.create`, запоминает сессию в реестре и `workspaceState` |
| `resume(id)` | `session.resume`; ошибка — `SessionManagerError` |
| `list()` | `session.list` воркспейса |
| `startTurn(input)` | `turn.start` в активной сессии; `turnId` попадает в снимок |
| `pause()` / `stop()` | `turn.cancel` текущего хода (если есть), сессия остаётся, статус `paused` |
| `getDraft()` / `setDraft()` | черновик composer'а в `workspaceState` (переживает рестарт IDE) |
| `on(event)` | `sessionChanged` (id/заголовок) и `statusChanged` (статус/ход) |

Публичные операции сериализуются внутри менеджера. `restore()` идемпотентен:
повторная активация (две параллельные, рестарт) не создаёт второй сессии.
`create()` — осознанное действие и всегда создаёт новую сессию; это не «двойной
клик», а команда `DSH: New Session`.

## Состояния

`idle` → `restoring` → `active` ⇄ `paused`; `offline` — мост недоступен
(`start()` бросил, ошибка создания). В снимке: `workspaceId`, `sessionId`,
`title`, `status`, `turnId`, `updatedAt`.

## Команды

`createSessionCommands({ getManager, ui })` — обработчики `DSH: New Session`,
`DSH: Resume Last Session`, `DSH: Stop Agent`: вызывают менеджер и показывают
результат. Команды регистрируются в `activate()`, менеджер появляется после
подключения моста и воркспейса (#011); до этого команда честно сообщает, что
мост не подключён.

## Проверка совместимости с мостом

`bridgePort.ts` — статическая проверка `DshBridge extends DshBridgePort`: если
сигнатуры моста (#004) разойдутся с портом, `pnpm typecheck` упадёт до проводки
в #011.

## Границы

- Запуск процесса DSH и `workspace.ping` — #004/#011; менеджер лишь вызывает
  `bridge.start()` перед операциями.
- Потоковый чат и tool-call-блоки — #008: он вызывает `startTurn`/`pause` и
  слушает события моста.
- Переключение воркспейса (`paused`/`teardown`) — #011.

## Устойчивость

- Ошибка записи в реестр/`workspaceState` логируется и **не** отменяет уже
  созданную/возобновлённую сессию и не переводит менеджер в `offline`.
- Время в реестр пишется на момент сохранения (а не конструктора): по нему
  реестр #003 сортирует записи и делает GC.
- `stop()`/`pause()` при отказе `turn.cancel` не врёт статусом: ход остаётся
  активным, менеджер бросает `SessionManagerError` (команда покажет ошибку).
