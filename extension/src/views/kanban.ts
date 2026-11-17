/**
 * Kanban-парсер и модель (#014): read-only карточки из `.kanban/tasks/*.md`.
 * Никаких записей на диск — только чтение front matter и тела.
 * Без `vscode`; тесты `tests/kanban.test.mjs`.
 */

export const KANBAN_COLUMNS = [
  'backlog',
  'todo',
  'in-progress',
  'in-review',
  'testing',
  'ready',
  'merged',
  'blocked'
] as const;

export type KanbanStatus = (typeof KANBAN_COLUMNS)[number];

export interface KanbanCard {
  readonly id: string;
  readonly title: string;
  readonly status: KanbanStatus;
  readonly owner: string;
  readonly branch: string;
  readonly updated: string;
  readonly path: string;
  /** Карточка из worktree-копии (`.kanban` внутри worktrees/<id>). */
  readonly inBranch: boolean;
  /** Ошибка разбора front matter (карточка всё равно показывается). */
  readonly parseError?: string | undefined;
}

export interface KanbanColumn {
  readonly status: KanbanStatus;
  readonly label: string;
  readonly cards: readonly KanbanCard[];
}

const LABELS: Readonly<Record<KanbanStatus, string>> = {
  backlog: 'Backlog',
  todo: 'Todo',
  'in-progress': 'In progress',
  'in-review': 'In review',
  testing: 'Testing',
  ready: 'Ready',
  merged: 'Merged',
  blocked: 'Blocked'
};

/** Разбор простого front matter: `key: "value"` / `key: value`. */
export function parseFrontMatter(content: string): Record<string, string> {
  const match = /^---\s*\n([\s\S]*?)\n---\s*(?:\n|$)/.exec(content);
  if (match === null) {
    return {};
  }
  const result: Record<string, string> = {};
  for (const line of (match[1] ?? '').split('\n')) {
    const entry = /^\s*([A-Za-z0-9_-]+)\s*:\s*(.*)\s*$/.exec(line);
    if (entry === null) {
      continue;
    }
    const key = entry[1] ?? '';
    let value = (entry[2] ?? '').trim();
    if (value.startsWith('"') && value.endsWith('"')) {
      value = value.slice(1, -1).replace(/\\"/g, '"');
    } else if (value.startsWith("'") && value.endsWith("'")) {
      value = value.slice(1, -1);
    }
    result[key] = value;
  }
  return result;
}

function normalizeStatus(value: string | undefined): KanbanStatus | null {
  return value !== undefined && (KANBAN_COLUMNS as readonly string[]).includes(value)
    ? (value as KanbanStatus)
    : null;
}

/** Разбирает карточку; битый front matter не бросает исключение. */
export function parseKanbanCard(content: string, filePath: string): KanbanCard {
  const idFromPath = /(?:^|\/)(\d+)\.md$/.exec(filePath)?.[1] ?? '';
  const front = parseFrontMatter(content);
  const status = normalizeStatus(front['status']);
  const heading = /^#\s+(.+)$/m.exec(content)?.[1]?.trim() ?? '';
  const inBranch = /(?:^|\/)worktrees\/\d+\/\.kanban\/tasks\//.test(filePath.replace(/\\/g, '/'));
  return {
    id: front['id'] ?? idFromPath,
    title: front['title'] ?? (heading === '' ? `Карточка ${idFromPath}` : heading),
    status: status ?? 'backlog',
    owner: front['owner'] ?? '',
    branch: front['branch'] ?? '',
    updated: front['updated'] ?? '',
    path: filePath,
    inBranch,
    ...(status === null && front['status'] !== undefined
      ? { parseError: `неизвестный статус: ${front['status']}` }
      : {})
  };
}

/** Дедупликация main/worktree по id: свежее `updated`, равенство — ветка. */
export function mergeKanbanCards(cards: readonly KanbanCard[]): KanbanCard[] {
  const byId = new Map<string, KanbanCard>();
  for (const card of cards) {
    const existing = byId.get(card.id);
    if (existing === undefined) {
      byId.set(card.id, card);
      continue;
    }
    const existingTime = Date.parse(existing.updated) || 0;
    const cardTime = Date.parse(card.updated) || 0;
    if (cardTime > existingTime || (cardTime === existingTime && card.inBranch && !existing.inBranch)) {
      byId.set(card.id, card);
    }
  }
  return [...byId.values()];
}

/** Группировка по колонкам в фиксированном порядке; карточки — по id. */
export function groupKanbanCards(cards: readonly KanbanCard[]): KanbanColumn[] {
  const merged = mergeKanbanCards(cards);
  return KANBAN_COLUMNS.map((status) => ({
    status,
    label: LABELS[status],
    cards: merged
      .filter((card) => card.status === status)
      .sort((left, right) => left.id.localeCompare(right.id, 'en', { numeric: true }))
  })).filter((column) => column.cards.length > 0);
}

/** Загружает карточки через переданные порты; только чтение. */
export async function loadKanbanCards(
  findFiles: () => Promise<readonly string[]>,
  read: (path: string) => Promise<string>
): Promise<KanbanCard[]> {
  const files = await findFiles();
  const cards = await Promise.all(
    files.map(async (filePath) => parseKanbanCard(await read(filePath), filePath))
  );
  return cards;
}

/** Текст для бейджа «в ветке». */
export function branchBadge(card: KanbanCard): string {
  return card.inBranch ? 'в ветке' : '';
}
