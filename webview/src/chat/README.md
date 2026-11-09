# `webview/src/chat` — потоковый чат

Лента панели: потоковые токены, блоки вызова инструментов, безопасный markdown,
умный автоскролл. Всё состояние собирается чистым редьюсером — компоненты только
рисуют.

## Модули

| Файл | Что делает |
|---|---|
| `reducer.ts` | `chatFeedReducer` (событие → состояние ленты), `shouldAutoScroll` |
| `markdown.ts` | `parseMarkdown`/`parseInline`/`sanitizeHref`/`markdownToPlainText` |
| `MarkdownView.tsx` | рендер блоков React-элементами, code-блок с копированием |
| `ToolCallBlock.tsx` | `<details>` с именем инструмента, статусом, длительностью, аргументами и результатом |

## Состояние ленты

`ChatFeedState`: `entries` (роль, текст, `toolCalls`, состояние
`done`/`streaming`/`cancelled`/`error`), `status` (`idle`/`streaming`/
`cancelled`/`error`), `turnId`, `error`.

События: `userMessage`, `token`, `toolCall`, `toolResult`, `done`, `cancelled`,
`error`, `status`, `appendMessage`, `replaceMessages`. Токены после отмены или
ошибки игнорируются — «остановленное» сообщение не дописывается. Поздние токены
и `turn.done` чужого хода отбрасываются по `turnId`; после отмены/ошибки
`tool.call`/`tool.result` не применяются, а незавершённые вызовы помечаются
прерванными. `done` с `finishReason: cancelled` оставляет статус `cancelled`
(а не «Готов»).

## Безопасность HTML

`parseMarkdown` не исполняет HTML: всё, что похоже на теги (`<script>`,
`<img onerror=…>`), остаётся текстовым узлом. Рендер — только React-элементы, без
`dangerouslySetInnerHTML`. Ссылки проходят `sanitizeHref`: разрешены `http(s):` и
`mailto:`, `javascript:`/`data:` превращаются в текст. Тесты:
`tests/chat-markdown.test.mjs` (XSS-кейсы).

## Автоскролл

`shouldAutoScroll({scrollTop, scrollHeight, clientHeight})` — прокрутка
происходит, только если пользователь у нижней границы (порог 48 px) или контент
короче окна. Иначе чтение предыдущих сообщений не дёргается от новых токенов.

## Тесты

`tests/chat-feed-reducer.test.mjs` — reducer и автоскролл;
`tests/chat-markdown.test.mjs` — markdown и XSS; контракт сообщений и батчинг
проверяются в `tests/chat-view.test.mjs` / `tests/chat-events.test.mjs`.
