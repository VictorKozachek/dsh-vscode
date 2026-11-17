# `webview/src/approvals` — инлайн-карточка подтверждения

Не модальное окно: карточка в ленте панели. Кнопки «Разрешить», «Разрешить для
этой сессии», «Отклонить» и (для записи с путём) «Показать diff».

- `approvalModel.ts` — чистая логика: набор действий, фокус-ловушка
  (`nextFocusIndex`), клавиатура (`handleApprovalKey`), форматирование
  аргументов, признак diff. Покрыта `tests/approval-model.test.mjs`.
- `ApprovalCard.tsx` — React-карточка: `role="alertdialog"`, `aria-modal="false"`,
  фокус на первой кнопке при появлении, Tab/Shift+Tab и стрелки ходят по кругу,
  Esc — «Отклонить», Enter — действие под фокусом. Текст аргументов — обычный
  текстовый узел (React экранирует), raw HTML не используется.

## Поток

1. extension host присылает `{ type: 'approvalRequest', request }`.
2. Панель показывает карточку; `approvalResolved` убирает её.
3. Нажатие кнопки отправляет `{ type: 'approvalResolve', id, decision }` или
   `{ type: 'approvalShowDiff', id }`; карточка скрывается оптимистично.

Контракт сообщений — `webview/src/messages.ts` (паритет с
`extension/src/views/chatHtml.ts` проверяет `tests/chat-view.test.mjs`).
