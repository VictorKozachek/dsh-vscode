# `extension/src/bridge` — DshBridge

Транспорт и супервизор процессов DSH: JSON-RPC 2.0 поверх stdio, рестарты,
healthcheck, graceful shutdown. Схема сообщений — `protocol/` (#004), здесь только
транспорт.

```
extension ──stdin/stdout (NDJSON)──▶ dsh serve --protocol=jsonrpc --cwd <workspace>
          ◀────── события ────────
stderr ────────────────────────────▶ OutputChannel «DSH»
```

## Запуск

```ts
import { DshBridge } from './bridge/dshBridge';

const bridge = new DshBridge({
  cwd: workspace.path,                 // корень воркспейса
  sandboxMode: 'workspace-write',      // dsh.sandboxMode
  executablePath: 'dsh',               // dsh.executablePath
  logger: outputChannel                // vscode.OutputChannel «DSH»
});

await bridge.start();                  // spawn + healthcheck workspace.ping
const session = await bridge.request('session.create', { workspaceId: workspace.id });
const tokens = bridge.on('token', (payload) => append(payload.text));
```

## Что гарантирует супервизор

| Свойство | Как сделано |
|---|---|
| Корреляция запрос/ответ | `id` инкрементом, `Map` висящих запросов; ответ без запроса и запрос без `id` логируются |
| Таймауты | `requestTimeoutMs` на запрос (по умолчанию 30 с), таймер снимается при ответе |
| Отмена | `AbortSignal` в `request(method, params, { signal })` |
| NDJSON-фрейминг | строка = сообщение; не-JSON строки не ломают мост, попадают в лог |
| Ошибки JSON-RPC | отклоняют запрос `DshBridgeError` с `code`/`data` из ответа |
| Healthcheck | после spawn — `workspace.ping` с `healthcheckTimeoutMs`; не прошёл — процесс снимается, попытка повторяется |
| Экспоненциальный backoff | `initialRestartDelayMs` × `restartDelayFactor`, потолок `maxRestartDelayMs`, попыток — `maxRestartAttempts` |
| Потеря процесса | висящие запросы отклоняются с «процесс DSH завершился (code, signal)», супервизор поднимает новый |
| Буферизация | запросы, пришедшие в `starting`/`restarting`, ждут процесса и уходят после успешного healthcheck |
| Graceful shutdown | `stop()`: SIGTERM → `shutdownGraceMs` → SIGKILL; `dispose()` синхронно снимает процесс и таймеры (`processCount === 0`) |
| Логи | stdout-мусор, `[rpc]`-ошибки, `[stderr]` процесса — всё в `OutputChannel` «DSH» |

События сервера (`token`, `tool.call`, `tool.result`, `approval.request`,
`turn.done`, `error`, `status`) приходят подпиской `bridge.on(event, listener)`.
Запрос от сервера (например, `approval.request` в виде request) клиент не
поддерживает и отвечает `-32601`, чтобы сервер не висел.

## Тесты

`tests/dsh-bridge.test.mjs` — на настоящих процессах фейкового сервера
`tests/fixtures/fake-dsh-server.mjs` (режимы: нормальный, `no-ping`,
`crash-once-on-create`, `crash-after-ready`, `exit-immediately`,
`ignore-sigterm`, `no-response`, `noisy`, `server-request`). Проверяется:
healthcheck, корреляция параллельных запросов, события хода, ошибки JSON-RPC,
таймауты и отмена, падение и перезапуск процесса с отклонением висящих
запросов, буферизация на время рестарта, отказ от бесконечных ретраев,
SIGTERM → SIGKILL, `dispose()` без остатков процессов и таймеров, stderr в логе.

## Границы

- Процесс DSH не запускается в extension host автоматически: проводку в
  активацию и статус-бар делает #007 (`SessionManager`) и #011 (жизненный цикл
  воркспейса). Здесь — готовый к использованию компонент.
- Реконнект на уровне сессий (`session.resume`) и восстановление истории — #007.
