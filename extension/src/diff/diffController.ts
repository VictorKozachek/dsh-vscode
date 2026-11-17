/**
 * Контроллер DiffService без `vscode`: предпросмотр, применение точного
 * содержимого и откат через порт `DiffEditorPort`. VS Code-редактор —
 * `diffEditor.ts`; тесты — `tests/diff-controller.test.mjs`.
 */

import type { DiffService, Preview, ProposedFileEdit } from './diffService';

/** Порт редактора: диффы, применение содержимого, undo-совместимость. */
export interface DiffEditorPort {
  /** Показать дифф «файл на диске ↔ новое содержимое» (не пишет файлы). */
  showDiff(files: readonly PreviewFileForUi[]): Promise<void>;
  /** Применить пачку атомарно (один `WorkspaceEdit`); `false` — ничего не применено. */
  applyBatch(
    files: readonly { readonly path: string; readonly content: string; readonly created: boolean }[]
  ): Promise<boolean>;
  /** Убрать виртуальные документы предпросмотра (все). */
  clearPreviews(): void;
  showError(message: string): void;
  showInfo(message: string): void;
}

/** Что показываем в диффе. */
export interface PreviewFileForUi {
  readonly path: string;
  readonly relativePath: string;
  readonly newContent: string;
  readonly newHash: string;
}



/** Контроллер правок текущего воркспейса. */
export class DiffController {
  readonly #service: DiffService;
  readonly #editor: DiffEditorPort;
  #pending: Preview | undefined;

  constructor(service: DiffService, editor: DiffEditorPort) {
    this.#service = service;
    this.#editor = editor;
  }

  get service(): DiffService {
    return this.#service;
  }

  /** Считает правки и показывает диффы; файлы на диске не меняются. */
  async preview(edits: readonly ProposedFileEdit[]): Promise<Preview> {
    const preview = await this.#service.preview(edits);
    this.#pending = preview;
    await this.#editor.showDiff(
      preview.files.map((file) => ({
        path: file.path,
        relativePath: file.relativePath,
        newContent: file.newContent,
        newHash: file.newHash
      }))
    );
    return preview;
  }

  /**
   * Применяет предпросмотр: сверка хешей → точное содержимое через редактор →
   * проверка фактического результата → только потом `markApplied`.
   */
  async apply(previewId?: string): Promise<'applied' | 'conflict' | 'stale'> {
    const preview = this.#pending;
    if (preview === undefined || (previewId !== undefined && preview.id !== previewId)) {
      return 'stale';
    }

    const verification = await this.#service.verify(preview);
    if (verification.status === 'conflict') {
      this.#editor.showError(
        `файл изменился с момента предпросмотра — ${verification.path}`
      );
      return 'conflict';
    }

    const applied = await this.#editor.applyBatch(
      preview.files.map((file) => ({
        path: file.path,
        content: file.newContent,
        created: file.created
      }))
    );
    if (!applied) {
      this.#editor.showError('не удалось применить правки');
      return 'conflict';
    }

    const check = await this.#service.checkApplied(preview);
    if (check.status === 'mismatch') {
      // После неудачной сверки нельзя понять, это сбой применения или чужая
      // правка. Ничего не перезаписываем (иначе затрём внешние изменения),
      // сообщаем конфликт и оставляем файлы пользователю/undo редактора.
      const changed = await this.#service.changedSinceApply(preview);
      this.#pending = undefined;
      this.#editor.clearPreviews();
      this.#editor.showError(
        `содержимое после применения не совпало — ${changed.join(', ') || check.path}`
      );
      return 'conflict';
    }

    this.#service.markApplied(preview);
    this.#pending = undefined;
    this.#editor.clearPreviews();
    return 'applied';
  }

  /** `DSH: Revert Last Edit`: откат последней применённой транзакции. */
  async revertLastEdit(): Promise<void> {
    if (!this.#service.canRevert) {
      this.#editor.showInfo('откатывать нечего');
      return;
    }
    const result = await this.#service.revertLast();
    switch (result.status) {
      case 'reverted':
        this.#editor.showInfo('правки откачены');
        return;
      case 'conflict':
        this.#editor.showError(
          `файл изменился после применения — откат отменён (${result.path})`
        );
        return;
      case 'failed':
        this.#editor.showError(`не удалось откатить правки: ${result.error} (${result.path})`);
        return;
      default:
        this.#editor.showInfo('откатывать нечего');
    }
  }

}
