/**
 * VS Code-обвязка DiffService (#010): предпросмотр через `vscode.diff` с
 * виртуальным документом, применение через `WorkspaceEdit` (один undo-шаг),
 * команда `DSH: Revert Last Edit`.
 *
 * Ядро (`diffService.ts`) не зависит от `vscode` и покрыто тестами; здесь
 * только интеграция с редактором. Создаётся в активации (#011), когда известен
 * воркспейс.
 */

import * as vscode from 'vscode';

import type { DiffService, Preview, ProposedFileEdit } from './diffService';

const SCHEME = 'dsh-diff';

/** Виртуальный документ с новым содержимым файла для `vscode.diff`. */
class DiffPreviewContentProvider implements vscode.TextDocumentContentProvider {
  readonly #contents = new Map<string, string>();

  set(uri: vscode.Uri, content: string): void {
    this.#contents.set(uri.toString(), content);
  }

  clear(uri: vscode.Uri): void {
    this.#contents.delete(uri.toString());
  }

  provideTextDocumentContent(uri: vscode.Uri): string {
    return this.#contents.get(uri.toString()) ?? '';
  }
}

/** Контроллер правок для текущего воркспейса. */
export class DiffController implements vscode.Disposable {
  readonly #service: DiffService;
  readonly #provider = new DiffPreviewContentProvider();
  readonly #providerRegistration: vscode.Disposable;
  #pendingPreview: Preview | undefined;

  constructor(service: DiffService, context: vscode.ExtensionContext) {
    this.#service = service;
    this.#providerRegistration = vscode.workspace.registerTextDocumentContentProvider(
      SCHEME,
      this.#provider
    );
    context.subscriptions.push(this.#providerRegistration);
  }

  get service(): DiffService {
    return this.#service;
  }

  /**
   * Считает правки и открывает диффы (файл на диске ↔ виртуальный документ).
   * Файлы на диске не меняются.
   */
  async preview(edits: readonly ProposedFileEdit[]): Promise<Preview> {
    const preview = await this.#service.preview(edits);
    this.#pendingPreview = preview;

    for (const file of preview.files) {
      const baseUri = vscode.Uri.file(file.path);
      const previewUri = vscode.Uri.parse(`${SCHEME}:${file.relativePath}`).with({
        query: `v=${file.newHash}`
      });
      this.#provider.set(previewUri, file.newContent);
      await vscode.commands.executeCommand(
        'vscode.diff',
        baseUri,
        previewUri,
        vscode.l10n?.t('diff.title', file.relativePath) ?? `DSH: ${file.relativePath}`
      );
    }

    return preview;
  }

  /**
   * Применяет предпросмотр одним `WorkspaceEdit` (undo в редакторе) после
   * проверки хешей. Конфликт — отказ без записи.
   */
  async apply(previewId?: string): Promise<'applied' | 'conflict' | 'stale'> {
    const preview = this.#pendingPreview;
    if (preview === undefined || (previewId !== undefined && preview.id !== previewId)) {
      return 'stale';
    }

    const verification = await this.#service.verify(preview);
    if (verification.status === 'conflict') {
      void vscode.window.showErrorMessage(
        vscode.l10n?.t('diff.conflict', verification.path) ??
          `DSH: файл изменился с момента предпросмотра — ${verification.path}`
      );
      return 'conflict';
    }

    const edit = new vscode.WorkspaceEdit();
    for (const file of preview.files) {
      if (file.created) {
        edit.createFile(vscode.Uri.file(file.path), { overwrite: true, contents: Buffer.from(file.newContent) });
        continue;
      }
      const document = await vscode.workspace.openTextDocument(vscode.Uri.file(file.path));
      for (const textEdit of file.textEdits) {
        const startLine = Math.min(textEdit.startLine - 1, Math.max(0, document.lineCount - 1));
        const start = new vscode.Position(startLine, 0);
        const endLine = Math.min(Math.max(textEdit.endLine, textEdit.startLine - 1), document.lineCount);
        const end =
          endLine >= document.lineCount
            ? document.lineAt(Math.max(0, document.lineCount - 1)).range.end
            : new vscode.Position(endLine, 0);
        edit.replace(vscode.Uri.file(file.path), new vscode.Range(start, end), textEdit.replacement);
      }
    }

    const applied = await vscode.workspace.applyEdit(edit);
    if (!applied) {
      void vscode.window.showErrorMessage(
        vscode.l10n?.t('diff.applyFailed') ?? 'DSH: не удалось применить правки'
      );
      return 'conflict';
    }

    this.#service.markApplied(preview);
    this.#pendingPreview = undefined;
    this.#provider.clear(
      vscode.Uri.parse(`${SCHEME}:${preview.files[0]?.relativePath ?? ''}`)
    );
    return 'applied';
  }

  /** `DSH: Revert Last Edit`: откат последней применённой транзакции. */
  async revertLastEdit(): Promise<void> {
    if (!this.#service.canRevert) {
      void vscode.window.showInformationMessage(
        vscode.l10n?.t('diff.nothingToRevert') ?? 'DSH: откатывать нечего'
      );
      return;
    }
    const result = await this.#service.revertLast();
    if (result.status === 'conflict') {
      void vscode.window.showErrorMessage(
        vscode.l10n?.t('diff.revertConflict', result.path) ??
          `DSH: файл изменился после применения — откат отменён (${result.path})`
      );
      return;
    }
    void vscode.window.showInformationMessage(
      vscode.l10n?.t('diff.reverted') ?? 'DSH: правки откачены'
    );
  }

  dispose(): void {
    this.#providerRegistration.dispose();
  }
}
