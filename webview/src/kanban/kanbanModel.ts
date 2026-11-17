/** Модель рендера Kanban в WebView (#014): колонки/карточки, read-only. */

export interface KanbanCardDto {
  readonly id: string;
  readonly status: string;
  readonly title: string;
  readonly owner: string;
  readonly branch: string;
  readonly updated: string;
  readonly path: string;
  readonly inBranch: boolean;
}

export interface KanbanColumnDto {
  readonly status: string;
  readonly label: string;
  readonly cards: readonly KanbanCardDto[];
}

export const COLUMN_LABELS: Readonly<Record<string, string>> = {
  backlog: 'Backlog',
  todo: 'Todo',
  'in-progress': 'In progress',
  'in-review': 'In review',
  testing: 'Testing',
  ready: 'Ready',
  merged: 'Merged',
  blocked: 'Blocked'
};

/** Группирует карточки в колонки; пустые колонки не показываем. */
export function buildKanbanColumns(cards: readonly KanbanCardDto[]): KanbanColumnDto[] {
  return Object.keys(COLUMN_LABELS)
    .map((status) => ({
      status,
      label: COLUMN_LABELS[status] ?? status,
      cards: cards
        .filter((card) => card.status === status)
        .sort((left, right) => left.id.localeCompare(right.id, 'en', { numeric: true }))
    }))
    .filter((column) => column.cards.length > 0);
}
