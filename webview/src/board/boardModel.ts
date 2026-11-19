/** Модель доски Kanban для webview (#036), без React/vscode. */

export type BoardStatus =
  | 'backlog'
  | 'todo'
  | 'in-progress'
  | 'in-review'
  | 'testing'
  | 'ready'
  | 'merged'
  | 'blocked';

export const BOARD_STATUSES: readonly BoardStatus[] = [
  'backlog',
  'todo',
  'in-progress',
  'in-review',
  'testing',
  'ready',
  'merged',
  'blocked'
];

export interface BoardCardDto {
  readonly id: string;
  readonly title: string;
  readonly status: BoardStatus;
  readonly owner: string;
  readonly branch: string;
  readonly updated: string;
  readonly inBranch: boolean;
  readonly path: string;
}

export interface BoardColumnDto {
  readonly status: BoardStatus;
  readonly label: string;
  readonly cards: readonly BoardCardDto[];
}

export interface BoardPluginStatusDto {
  readonly installed: boolean;
  readonly profile: string;
  readonly installCommand: string;
  readonly reason?: string | undefined;
}

export interface BoardDataDto {
  readonly columns: readonly BoardColumnDto[];
  readonly plugin: BoardPluginStatusDto;
  readonly empty: boolean;
}

const LABELS: Readonly<Record<BoardStatus, string>> = {
  backlog: 'Backlog',
  todo: 'Todo',
  'in-progress': 'In progress',
  'in-review': 'In review',
  testing: 'Testing',
  ready: 'Ready',
  merged: 'Merged',
  blocked: 'Blocked'
};

/** Колонки в фиксированном порядке, счётчики и пустое состояние. */
export function buildBoardData(
  columns: readonly {
    readonly status: BoardStatus;
    readonly cards: readonly BoardCardDto[];
  }[],
  plugin: BoardPluginStatusDto
): BoardDataDto {
  const byStatus = new Map(columns.map((column) => [column.status, column.cards]));
  const built = BOARD_STATUSES.map((status) => ({
    status,
    label: LABELS[status],
    cards: (byStatus.get(status) ?? []).slice()
  }));
  return {
    columns: built,
    plugin,
    empty: built.every((column) => column.cards.length === 0)
  };
}

/** Бейджи карточки: owner / branch / «в ветке». */
export function cardBadges(card: BoardCardDto): string[] {
  const badges: string[] = [];
  if (card.owner !== '') {
    badges.push(`owner: ${card.owner}`);
  }
  if (card.branch !== '') {
    badges.push(`branch: ${card.branch}`);
  }
  if (card.inBranch) {
    badges.push('в ветке');
  }
  return badges;
}

export function boardCounts(data: BoardDataDto): Readonly<Record<BoardStatus, number>> {
  return Object.fromEntries(
    data.columns.map((column) => [column.status, column.cards.length])
  ) as Record<BoardStatus, number>;
}
