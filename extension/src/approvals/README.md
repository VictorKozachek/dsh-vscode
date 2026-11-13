# `extension/src/approvals` — подтверждения и sandbox-политики (#009)

Инлайн-подтверждения вместо модальных окон (§8 спецификации): политика
`ask`/`auto`/`never`, маппинг sandbox-режимов, обязательные подтверждения для
записи вне воркспейса и сетевых вызовов, аудит и fallback в уведомление.

| Файл | Что делает |
|---|---|
| `approvalPolicy.ts` | чистая матрица решений `allow`/`ask`/`deny`; `parseSandboxMode`, `toDshSandboxArguments`, `isPathInsideWorkspace` |
| `approvalBroker.ts` | очередь pending-запросов, «разрешить для сессии», аудит, dispose |
| `auditLog.ts` | JSONL `.dsh/audit.log`, ротация по размеру, фильтрация секретов |
| `fallback.ts` | `showInformationMessage` с теми же тремя действиями, когда панель скрыта |

## Политика

| Операция | `ask` | `auto` | `never` |
|---|---|---|---|
| чтение | allow | allow | allow |
| запись внутри воркспейса | ask | allow | deny |
| запись **вне** воркспейса | ask | **ask** (обязательно) | deny |
| сетевой вызов | ask | **ask** (обязательно) | deny |
| запуск команды | ask | allow | deny |
| sandbox `read-only` + запись/команда | deny | deny | deny |

Политику можно переопределить на инструмент: `toolPolicies: { write_file: 'ask' }`.
`never` не подтверждает ничего: операции, которым нужен ответ пользователя,
запрещаются. `auto` не снимает обязательные подтверждения (вне воркспейса, сеть).

## Брокер

```ts
const broker = new ApprovalBroker({
  context: { workspaceRoot, sandboxMode, policy },
  evaluate: evaluateApproval,
  ui: cardUi,          // панель или fallback
  audit: new AuditLog({ filePath: path.join(root, '.dsh', 'audit.log') })
});

const decision = await broker.request({ id, tool, kind, targetPath, sessionId });
if (decision === 'deny') return; // инструмент не выполняется
```

- `resolve(id, decision)` — решение из WebView; неизвестный id → `false`
  (карточка устарела);
- `showDiff(id)` — отдаёт запрос сервису диффов (#010);
- `dispose()` закрывает все pending как `deny` (панель закрылась/сессия кончилась);
- «Разрешить для этой сессии» запоминается для пары сессия+инструмент.

Проводка к мосту (`approval.request` → `broker.request`, `ui.ask` →
`postMessage approvalRequest`, `approvalResolve` → `broker.resolve`) живёт в
#011: провайдер панели принимает `approvals` порт, а диспетчер WebView уже
маршрутизирует `approvalResolve`/`approvalShowDiff`.

## Аудит

`.dsh/audit.log`, одна JSON-запись на строку: `timestamp`, `sessionId`, `tool`,
`kind`, `targetPath`, `decision`, `source` (`policy`/`user`/`dispose`/`timeout`),
`reason`, `arguments`. Аргументы чистятся: ключи `token`/`secret`/`password`/
`apiKey`/`auth`/… удаляются рекурсивно, из URL вычищается userinfo. Ротация:
при превышении `maxBytes` (по умолчанию 1 МБ) журнал уезжает в `.1`, `.2`, …
(`maxFiles` = 3); права `0600`.

## Тесты

`tests/approvals-policy.test.mjs` (матрица, пути, sandbox), `tests/approvals-audit.test.mjs`
(JSONL, ротация, секреты), `tests/approval-broker.test.mjs` (deny останавливает
инструмент, allow-session, внешнее решение, dispose, fallback), `tests/approval-model.test.mjs`
(фокус-ловушка и клавиатура карточки).
