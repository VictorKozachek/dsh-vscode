/**
 * Модель списка сессий DSH (#022) — без `vscode`.
 *
 * Собирает состояние панели Sessions: загрузка/пусто/ошибка/готово, группы по
 * дате, бейджи `active`/`idle`/`error`, подписи и tooltip. Используется
 * `SessionsController` и `sessionsView.ts`; тесты —
 * `tests/sessions-model.test.mjs`.
 */

import type { DshSessionSummary } from '@dsh-vscode/protocol';

import type { SessionSnapshot } from '../sessions/sessionManager';

/** Бейдж сессии. */
export type SessionBadge = 'active' | 'idle' | 'error';

/** Строка списка. */
export interface SessionViewItem {
  readonly id: string;
  readonly label: string;
  readonly description: string;
  readonly tooltip: string;
  readonly badge: SessionBadge;
  /** Контекст для меню (`dshSession.active` / `dshSession`). */
  readonly contextValue: string;
  readonly updatedAt: string;
  readonly workspaceId: string;
}

/** Группа по дате. */
export type SessionGroupKey = 'today' | 'yesterday' | 'earlier';

export interface SessionGroup {
  readonly key: SessionGroupKey;
  readonly label: string;
  readonly items: readonly SessionViewItem[];
}

/** Состояние панели. */
export type SessionsViewState =
  | { readonly kind: 'loading'; readonly groups: readonly [] }
  | { readonly kind: 'empty'; readonly groups: readonly [] }
  | {
      readonly kind: 'error';
      readonly groups: readonly [];
      readonly error: {
        readonly message: string;
        readonly canRetry: boolean;
        readonly settingsHint: string;
      };
    }
  | {
      readonly kind: 'ready';
      readonly groups: readonly SessionGroup[];
      readonly activeSessionId: string | null;
    };

/** Подпись пустого состояния. */
export const EMPTY_TITLE = 'Сессий нет — создайте первую';

/** Подсказка в состоянии ошибки. */
export const SETTINGS_HINT =
  'Проверьте dsh.executablePath и что рантайм DSH установлен: npm i -g @deepseek-ai/dsh';

/** Заголовки групп. */
export const GROUP_LABELS: Readonly<Record<SessionGroupKey, string>> = {
  today: 'Сегодня',
  yesterday: 'Вчера',
  earlier: 'Ранее'
};

const GROUP_ORDER: readonly SessionGroupKey[] = ['today', 'yesterday', 'earlier'];

/** Вход для сборки состояния. */
export interface BuildSessionsInput {
  readonly sessions: readonly DshSessionSummary[];
  readonly snapshot: SessionSnapshot;
  readonly now: Date;
  /** Первая загрузка: показываем «загрузка», если данных ещё нет. */
  readonly loading?: boolean | undefined;
  /** Ошибка загрузки списка/рантайма. */
  readonly error?: string | null | undefined;
}

/** День относительно `now` по локальной дате. */
export function bucketOf(updatedAt: string, now: Date): SessionGroupKey {
  const timestamp = Date.parse(updatedAt);
  if (Number.isNaN(timestamp)) {
    return 'earlier';
  }
  const day = 24 * 60 * 60 * 1000;
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  if (timestamp >= startOfToday) {
    return 'today';
  }
  if (timestamp >= startOfToday - day) {
    return 'yesterday';
  }
  return 'earlier';
}

/** Название сессии: заголовок или короткий id. */
export function sessionLabel(session: DshSessionSummary): string {
  const title = session.title?.trim();
  return title === undefined || title === '' ? `Сессия ${session.id.slice(0, 8)}` : title;
}

/** Строит состояние панели. */
export function buildSessionsView(input: BuildSessionsInput): SessionsViewState {
  const offline = input.snapshot.status === 'offline';
  const error = input.error ?? (offline ? 'рантайм DSH недоступен' : null);
  if (error !== null && error !== undefined) {
    return {
      kind: 'error',
      groups: [],
      error: { message: error, canRetry: true, settingsHint: SETTINGS_HINT }
    };
  }
  if (input.loading === true && input.sessions.length === 0) {
    return { kind: 'loading', groups: [] };
  }
  if (input.sessions.length === 0) {
    return { kind: 'empty', groups: [] };
  }

  const activeSessionId = input.snapshot.sessionId;
  const sessions = [...input.sessions];
  // Активная сессия может отсутствовать в list (ACP отдаёт её после close) —
  // дополняем из снимка, иначе она не отрисуется.
  if (
    activeSessionId !== null &&
    !sessions.some((session) => session.id === activeSessionId)
  ) {
    sessions.push({
      id: activeSessionId,
      workspaceId: input.snapshot.workspaceId,
      ...(input.snapshot.title === null ? {} : { title: input.snapshot.title }),
      updatedAt: input.snapshot.updatedAt
    });
  }

  const byGroup = new Map<SessionGroupKey, SessionViewItem[]>();
  for (const session of sessions) {
    const item = toItem(session, activeSessionId);
    const group = bucketOf(session.updatedAt, input.now);
    const list = byGroup.get(group) ?? [];
    list.push(item);
    byGroup.set(group, list);
  }

  const groups: SessionGroup[] = [];
  for (const key of GROUP_ORDER) {
    const items = byGroup.get(key);
    if (items === undefined || items.length === 0) {
      continue;
    }
    items.sort((left, right) => {
      const activeDelta =
        Number(right.badge === 'active') - Number(left.badge === 'active');
      if (activeDelta !== 0) {
        return activeDelta;
      }
      return Date.parse(right.updatedAt) - Date.parse(left.updatedAt);
    });
    groups.push({ key, label: GROUP_LABELS[key], items });
  }

  // Активная сессия — первой во всём списке: её группа поднимается наверх.
  const activeGroupIndex = groups.findIndex((group) =>
    group.items.some((item) => item.badge === 'active')
  );
  if (activeGroupIndex > 0) {
    const [activeGroup] = groups.splice(activeGroupIndex, 1);
    if (activeGroup !== undefined) {
      groups.unshift(activeGroup);
    }
  }

  return { kind: 'ready', groups, activeSessionId };
}

function toItem(session: DshSessionSummary, activeSessionId: string | null): SessionViewItem {
  const active = session.id === activeSessionId;
  const badge: SessionBadge = active
    ? 'active'
    : session.status === 'error'
      ? 'error'
      : 'idle';
  const details = [
    active ? 'активна' : session.status === 'error' ? 'ошибка' : shortDate(session.updatedAt),
    session.preset ?? null,
    session.model ?? null
  ].filter((value): value is string => value !== null && value !== '');
  return {
    id: session.id,
    label: sessionLabel(session),
    description: details.join(' · '),
    tooltip: [
      sessionLabel(session),
      `id: ${session.id}`,
      `воркспейс: ${session.workspaceId}`,
      session.preset === undefined ? null : `пресет: ${session.preset}`,
      session.model === undefined ? null : `модель: ${session.model}`,
      `обновлена: ${session.updatedAt}`,
      active ? 'клик: уже активна' : 'клик: сделать активной'
    ]
      .filter((line): line is string => line !== null)
      .join('\n'),
    badge,
    contextValue: active ? 'dshSession.active' : 'dshSession',
    updatedAt: session.updatedAt,
    workspaceId: session.workspaceId
  };
}

function shortDate(updatedAt: string): string {
  const date = new Date(updatedAt);
  if (Number.isNaN(date.getTime())) {
    return 'дата неизвестна';
  }
  const pad = (value: number): string => String(value).padStart(2, '0');
  return `${pad(date.getDate())}.${pad(date.getMonth() + 1)} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** Fallback-опрос панели, пока она видима (события — приоритетный путь). */
export class SessionRefreshLoop {
  readonly #refresh: () => Promise<void> | void;
  readonly #intervalMs: number;
  readonly #schedule: (callback: () => void, delayMs: number) => unknown;
  readonly #cancel: (handle: unknown) => void;
  #timer: unknown;
  #running = false;

  constructor(options: {
    readonly refresh: () => Promise<void> | void;
    readonly intervalMs?: number | undefined;
    readonly schedule?: ((callback: () => void, delayMs: number) => unknown) | undefined;
    readonly cancel?: ((handle: unknown) => void) | undefined;
  }) {
    this.#refresh = options.refresh;
    this.#intervalMs = options.intervalMs ?? 5000;
    this.#schedule =
      options.schedule ?? ((callback, delayMs) => setTimeout(callback, delayMs));
    this.#cancel = options.cancel ?? ((handle) => clearTimeout(handle as NodeJS.Timeout));
  }

  get running(): boolean {
    return this.#running;
  }

  get intervalMs(): number {
    return this.#intervalMs;
  }

  /** Старт опроса (панель стала видимой). */
  start(): void {
    if (this.#running) {
      return;
    }
    this.#running = true;
    this.#arm();
  }

  /** Стоп опроса (панель скрыта). */
  stop(): void {
    this.#running = false;
    if (this.#timer !== undefined) {
      this.#cancel(this.#timer);
      this.#timer = undefined;
    }
  }

  /** Сбросить таймер после события рантайма/ручного refresh. */
  reset(): void {
    if (!this.#running) {
      return;
    }
    if (this.#timer !== undefined) {
      this.#cancel(this.#timer);
    }
    this.#arm();
  }

  #arm(): void {
    this.#timer = this.#schedule(() => {
      this.#timer = undefined;
      if (!this.#running) {
        return;
      }
      void this.#refresh();
      this.#arm();
    }, this.#intervalMs);
  }
}
