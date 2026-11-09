# `extension/src/views` — панель DSH

Контейнер `DSH` в activity bar и WebView чата `dsh.chat`. Содержимое панели —
React-приложение из `webview/`; extension host только собирает HTML-оболочку с
CSP и проксирует сообщения.

```
activity bar ─▶ dsh.chat (WebView) ─▶ extension/dist/webview/index.html + assets
                        ▲   │                  ▲
             postMessage│   │postMessage       │ копируется из webview/dist
                        │   ▼                  │
            ChatViewProvider (extension host) ─┘
```

`webview/scripts/copy-dist.mjs` (шаг `pnpm build` в пакете webview) кладёт
собранный WebView в `extension/dist/webview`: панель ищет ассеты относительно
`context.extensionUri`, иначе они не найдутся ни в Extension Development Host,
ни в будущем VSIX.

## Манифест

```jsonc
"viewsContainers": { "activitybar": [{ "id": "dsh", "title": "DSH", "icon": "media/dsh.svg" }] },
"views": { "dsh": [{ "id": "dsh.chat", "name": "Chat", "type": "webview", "contextualTitle": "DSH" }] }
```

Иконка — `extension/media/dsh.svg`, монохромная, красится темой.

## `ChatViewProvider`

- читает `extension/dist/webview/index.html` (через `vscode.workspace.fs`,
  работает и в remote), достаёт относительные пути скрипта и стилей и переводит
  их в `webview.asWebviewUri`; `localResourceRoots` ограничен этой папкой;
- собирает HTML с `Content-Security-Policy` и nonce: `default-src 'none'`,
  `script-src 'nonce-…'`, `style-src <cspSource> 'unsafe-inline'`,
  инлайновых скриптов нет;
- если WebView ещё не собран — показывает заглушку «`pnpm build`» вместо
  падения;
- `retainContextWhenHidden: true`: панель не теряет ленту при переключении вкладок.

Чистые части — `chatHtml.ts` (модуль без `vscode`, покрыт `tests/chat-view.test.mjs`
и `tests/chat-session.test.mjs`):

- `parseWebviewMessage`, `extractViteAssets`, `renderChatViewHtml`,
  `renderChatViewNoticeHtml` — разбор и HTML-оболочка с CSP;
- `buildChatViewHtml` — сборка страницы из `webview/dist` (или заглушка), `lang`
  берётся из локали панели;
- `ChatSession` — лента/статус и обработка сообщений WebView: `ready` → `state`
  (+ `replaceMessages`), `sendMessage` → сразу `thinking` + сообщение
  пользователя, через 150 мс — ответ-эхо и `idle`; `stop` отменяет неотправленный
  ответ и включает `stopped`. Благодаря паузе кнопка «Стоп» реально активна во
  время ответа.

## Сообщения

| WebView → extension | Расширение |
|---|---|
| `ready` | панель готова: extension присылает `state` (и `replaceMessages`, если лента уже была) |
| `sendMessage { text }` | пустой текст отбрасывается; в ленту уходят сообщение пользователя и ответ |
| `stop` | статус `stopped` |

| extension → WebView | Назначение |
|---|---|
| `state` | имя воркспейса, модель, sandbox, статус, локаль |
| `message` | новое сообщение в ленту |
| `status` | `idle` / `thinking` / `stopped` |
| `replaceMessages` | заменить ленту целиком |

На этом этапе ответ — эхо («Эхо: …» / «Echo: …» по локали) с паузой 150 мс;
реальный обмен через `DshBridge` — #008.
`ChatViewProvider.appendMessage()`/`postMessage()` — точка входа для #008/#013.

## Webview

- Шапка: имя воркспейса, модель, sandbox, кнопка «Стоп» (активна во время хода).
- Лента: пустое состояние с подсказкой, автоскролл, `role="log"` + `aria-live`.
- Composer: `textarea`, Enter — отправить, Shift+Enter — новая строка,
  подпись для скринридера и подсказка.
- Статус-строка: состояние, токены/время (каркас, наполнит #008).
- Темы: только `--vscode-*` переменные (`--vscode-foreground`,
  `--vscode-button-*`, `--vscode-focusBorder`, `--vscode-panel-border`, …),
  поэтому light/dark и высококонтрастные темы работают без отдельных правил.
- Доступность: `:focus-visible` на кнопках и composer, `role="log"`,
  `aria-label`/`aria-describedby`, `aria-live` у статуса, `prefers-reduced-motion`.
- i18n: `webview/src/i18n/index.ts` — словари `ru`/`en`, `resolveLocale()`
  (язык VS Code приходит в `state.locale`), паритет ключей проверяет
  `tests/webview-i18n.test.mjs`.

## Проверка темы и доступности

1. `pnpm build` — собирает `webview/dist` (ошибка типов валит сборку: `tsc --noEmit && vite build`).
2. В Extension Development Host: `Ctrl/Cmd+Shift+P` → «View: Appearance» →
   переключить светлую/тёмную тему, панель DSH должна сохранять контраст.
3. Фокус: `Tab` доходит до composer и кнопок, фокус виден; `Enter` отправляет,
   `Shift+Enter` переносит строку; лента объявляется скринридером как log.

## Потоковый чат (#008)

`chatEvents.ts` — мост между событиями `DshBridge` и панелью:

- `ChatController` подписывается на `token`, `tool.call`, `tool.result`,
  `turn.done`, `error` и шлёт в WebView сообщения `chatToken`, `chatToolCall`,
  `chatToolResult`, `chatDone`, `chatStatus`;
- `TokenBatcher` копит токены и отдаёт пачку не чаще 33 мс (~30 fps): длинный
  ответ — одно `postMessage` на кадр, а не сотни;
- `send(text)` → `turn.start` (сообщение пользователя уходит в ленту сразу),
  `cancel()` → `turn.cancel`, затем `chatCancelled` и статус `cancelled`;
- `turn.done`/`tool.call`/`tool.result`/отмена принудительно сбрасывают батчер,
  чтобы хвост токенов не терялся;
- `dispose()` снимает подписки на мост и таймер батчера — утечек listener'ов нет.

Провайдер панели принимает `chat?: ChatController`: при наличии он заменяет
эхо-режим каркаса, иначе панель работает как раньше. Проводка контроллера к
реальному `DshBridge` и `SessionManager` — #011 (в активации расширения).

Контракт сообщений расширен в `chatHtml.ts` (`chatStatus`, `chatToken`,
`chatToolCall`, `chatToolResult`, `chatDone`, `chatCancelled`); паритет с
`webview/src/messages.ts` проверяет `tests/chat-view.test.mjs`.
