import type { ReactElement } from 'react';
import {
  cardBadges,
  type BoardCardDto,
  type BoardDataDto
} from './boardModel';

/** Доска Kanban: колонки, карточки, статус плагина (#036). */
export function Board({
  data,
  onRefresh,
  onInstall,
  onOpenCard,
  onCreateBoard,
  pluginBannerHidden = false,
  onHidePlugin
}: {
  readonly data: BoardDataDto;
  readonly onRefresh: () => void;
  readonly onInstall: () => void;
  readonly onOpenCard: (card: BoardCardDto) => void;
  readonly onCreateBoard: () => void;
  readonly pluginBannerHidden?: boolean | undefined;
  readonly onHidePlugin?: (() => void) | undefined;
}): ReactElement {

  return (
    <section className="dsh-board" aria-label="Kanban доска">
      <header className="dsh-board__header">
        <strong>Kanban</strong>
        <span className="dsh-board__count">
          {data.columns.reduce((total, column) => total + column.cards.length, 0)} карточек
        </span>
        <button type="button" className="dsh-button" onClick={onRefresh} aria-label="Обновить доску">
          ⟳
        </button>
      </header>
      {!pluginBannerHidden ? (
        <div className={`dsh-board__plugin${data.plugin.installed ? ' dsh-board__plugin--ok' : ''}`} role="status">
          {data.plugin.installed
            ? `Kanban: плагин DSH активен — наряды рассылаются (профиль ${data.plugin.profile})`
            : `Kanban: плагин не установлен (профиль ${data.plugin.profile})`}
          {data.plugin.installed ? null : (
            <span className="dsh-board__plugin-actions">
              <button type="button" className="dsh-button" onClick={onInstall}>
                Установить
              </button>
              <button
                type="button"
                className="dsh-button"
                onClick={() => onHidePlugin?.()}
              >
                Работать со встроенной доской
              </button>
            </span>
          )}
        </div>
      ) : null}
      {data.empty ? (
        <div className="dsh-board__empty">
          <p>В проекте нет `.kanban/tasks` — создать доску?</p>
          <button type="button" className="dsh-button" onClick={onCreateBoard}>
            Создать доску
          </button>
        </div>
      ) : (
        <div className="dsh-board__columns" role="list">
          {data.columns.map((column) => (
            <div className="dsh-board__column" key={column.status} role="listitem">
              <h3 className="dsh-board__column-title">
                {column.label} <span>{column.cards.length}</span>
              </h3>
              {column.cards.map((card) => (
                <button
                  type="button"
                  key={card.path}
                  className="dsh-board__card"
                  onClick={() => onOpenCard(card)}
                  title={card.path}
                >
                  <span className="dsh-board__card-id">{card.id}</span>
                  <span className="dsh-board__card-title">{card.title}</span>
                  <span className="dsh-board__badges">
                    {cardBadges(card).map((badge) => (
                      <span key={badge} className="dsh-board__badge">
                        {badge}
                      </span>
                    ))}
                  </span>
                  <span className="dsh-board__updated">{card.updated}</span>
                </button>
              ))}
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
