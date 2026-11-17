# ADR 0001. Транспорт к настоящему DSH-рантайму

- **Статус:** принято (#021)
- **Дата:** 2026-11-13
- **Контекст:** `DshBridge` (#004) запускал `dsh serve --protocol=jsonrpc`, но
  такого бинаря и режима не существует. Нужен реальный рантайм с
  `session.list/create/resume` и `turn.start/cancel`, при этом публичный API
  моста и `SessionManager` (#007) менять не хочется.

## Рассмотренные маршруты

### (a) `dsh --profile web` + HTTP/WebSocket Gateway `/api`

Веб-профиль поднимает HTTP-сервер: `/api` — Typert Gateway RPC (envelope
`client-request`/`server-response`), WebSocket — поток событий. Доступ
закрыт launch-токеном в стартовом URL, обмениваемым на подписанную cookie;
есть Host/Origin fence.

Плюсы: это тот же рантайм, что у GUI; есть `remote.session.*`.
Минусы: нужен браузерный token-exchange, cookie-jar, WS-канал и разбор
Gateway-envelope; фронтенд-специфичный слой (static dist, браузерный roster)
для headless-расширения лишний; API помечен как browser transport.

### (b) `dsh --profile acp` — automation-only JSON-RPC stdio (принято)

(В карточке (b) описано как ручной `profile-boot`; по итогам спайка выяснилось,
что штатный `dsh --profile acp` — это и есть automation-only ACP-сервер, он
проще и стабильнее ручного boot. Профиль по умолчанию в манифесте — `acp`
(в тексте карточки упомянут `web`; `web` — это HTTP GUI, для расширения не
нужен). Отклонение согласовано с оркестратором через карточку #021.

ACP-профиль (`@deepseek-ai/dsh-acp`) — штатный automation-сервер: NDJSON
JSON-RPC поверх stdio, методы `initialize`, `session/new`, `session/list`,
`session/resume`, `session/close`, `session/prompt`, `session/cancel`,
`session/setConfigOption`. Никакой авторизации, портов и cookie: процесс
принадлежит расширению.

Плюсы:
- формат кадра совпадает с нашим `DshBridge` (NDJSON, JSON-RPC 2.0) — транспорт
  подменяется без изменения публичного API;
- 1:1 маппинг: `session.list/create/resume`, `turn.start` → `session/prompt`,
  `turn.cancel` → notification `session/cancel`;
- процесс гасится SIGTERM/SIGKILL, ничего не остаётся;
- работает без модели: `initialize`/`session.*` не требуют API-ключа.

Минусы/риски: ACP в rc-версии; `session/list` показывает только закрытые
(сохранённые) сессии — активная сессия появляется в списке после
`session/close` (проверено на 0.2.2-rc.1); `session/prompt` — блокирующий
запрос на весь ход (обходим немедленным `turnId` и событиями).

### (c) Подключение к уже запущенному приложению

Только research: desktop-процесс живёт под Electron-приложением, порт/токен
внутренние; контракт не публичный. Не используем.

## Решение

Расширение запускает `dsh --profile acp` как дочерний процесс и говорит с ним
по NDJSON JSON-RPC. `AcpRuntime` реализует порт `DshBridgePort`
(`start/stop/request/on`), поэтому `SessionManager` (#007) и будущие
потребители (#011) подключают его без правок своей логики.

Поиск бинаря: `dsh.executablePath` → `dsh` в PATH → профиль
`~/.dsh/profiles/<profile>/node_modules/.bin/dsh` → `npx @deepseek-ai/dsh`.
Профиль по умолчанию — `acp` (`dsh.profile`). Явно заданный
`dsh.executablePath` не существует → состояние `failed` с инструкцией
(`npm i -g @deepseek-ai/dsh`), extension host жив.

## Проверка

Спайк на `@deepseek-ai/dsh@0.2.2-rc.1` (DSH_HOME во временном каталоге):

- `dsh --profile acp` поднимается, `initialize` возвращает
  `agentInfo.version = 0.0.1`, `protocolVersion = 1`;
- `session/list` → `{sessions: []}`; `session/new` → `sessionId`;
  `session/close` → сессия появляется в `session/list`; `session/resume` →
  `configOptions`;
- `session/cancel` — notification, `session/prompt` завершается
  `stopReason: "cancelled"`.

Интеграционные тесты (`tests/acp-runtime.test.mjs`) гоняют тот же протокол на
фейковом ACP-процессе; `tests/dsh-runtime-e2e.test.mjs` (опционально,
`DSH_E2E_DSH_BIN`) проверяет реальный бинарь.

## Последствия

- Новых npm-зависимостей нет: клиент ACP — свой NDJSON peer (~150 строк),
  рантайм ставится пользователем глобально.
- Если ACP-профиль окажется недоступен в будущих версиях, запасной маршрут —
  (a) HTTP Gateway; для него уже есть точки расширения: транспорт изолирован
  в `AcpRuntime`, `SessionManager` не меняется.
- `session/prompt` может идти минутами: таймаут хода — 30 минут, отмена —
  `session/cancel`; события хода идут уведомлениями `session/update`.
