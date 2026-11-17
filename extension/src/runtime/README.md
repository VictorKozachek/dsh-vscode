# `extension/src/runtime` — настоящий DSH-рантайм (#021)

`AcpRuntime` запускает `dsh --profile acp` (automation-only ACP stdio) и
реализует порт `DshBridgePort` (#004/#007): `start/stop/request/on`.
Маршрут и риски — `docs/adr/0001-dsh-runtime.md`.

| Файл | Что делает |
|---|---|
| `discovery.ts` | поиск бинаря: настройка → PATH → профиль → npx; инструкция «не найден»; `redactSecrets` |
| `acpPeer.ts` | NDJSON JSON-RPC клиент (корреляция id, таймауты, уведомления) |
| `acpProtocol.ts` | маппинг нашего API ↔ ACP (`session.list/create/resume`, `turn.start/cancel`, `session/update`) |
| `acpRuntime.ts` | супервизор: spawn, `initialize`, версии, backoff-рестарт, SIGTERM→SIGKILL, диагностика |

## Использование

```ts
const runtime = new AcpRuntime({
  workspacePath,
  executablePath: configuration.get('executablePath'),
  profile: configuration.get('profile') ?? 'acp',
  homeDirectory: os.homedir(),
  logger: (line) => output.appendLine(line)
});
await runtime.start();                       // failed + instructions, если не найден
const sessions = await runtime.request('session.list', { workspaceId });
const { sessionId } = await runtime.request('session.create', { workspaceId });
await runtime.request('turn.start', { sessionId, input });
runtime.on('token', (payload) => …);
await runtime.stop();                        // процессов не остаётся
```

- `diagnostics`: состояние (`starting/running/restarting/failed`), сообщение,
  инструкция установки, путь и версии (`dsh 0.2.2-rc.1`, ACP `0.0.1`).
- `request` отклоняется, пока рантайм не `running`; «не найден» не бросается из
  `start()`, чтобы extension host оставался жив.
- Логи проходят `redactSecrets`: `?token=…`, `Bearer …`, userinfo из URL не
  попадают в вывод.

## Тесты

`tests/runtime-discovery.test.mjs` (порядок поиска, инструкция, редактирование),
`tests/acp-protocol.test.mjs` (маппинг методов/событий),
`tests/acp-runtime.test.mjs` (фейковый ACP-процесс: сессии, ход, отмена,
рестарт, отсутствие бинаря, остановка), `tests/dsh-runtime-e2e.test.mjs`
(опционально — реальный `dsh`, если задан `DSH_E2E_DSH_BIN`).
