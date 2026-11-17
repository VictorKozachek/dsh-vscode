import type { ReactElement } from 'react';

import type { KanbanColumnDto } from './kanbanModel';

/** Read-only колонки Kanban; клик открывает файл карточки (#014). */
export function KanbanBoard({
  columns,
  onOpen
}: {
  readonly columns: readonly KanbanColumnDto[];
  readonly onOpen: (path: string) => void;
}): ReactElement {
  return (
    <div className="dsh-kanban" role="list">
      {columns.map((column) => (
        <section key={column.status} className="dsh-kanban__column" aria-label={column.label}>
          <h3>{column.label} ({column.cards.length})</h3>
          {column.cards.map((card) => (
            <button
              key={card.id}
              type="button"
              className="dsh-kanban__card"
              onClick={() => onOpen(card.path)}
            >
              <strong>{card.id}</strong> {card.title}
              <small>
                {[card.owner, card.inBranch ? 'в ветке' : '', card.updated]
                  .filter((part) => part !== '')
                  .join(' · ')}
              </small>
            </button>
          ))}
        </section>
      ))}
    </div>
  );
}
