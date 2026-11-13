/**
 * VS Code-редактор для DiffController: виртуальные документы `vscode.diff`,
 * применение одним `WorkspaceEdit` (undo редактора) и сообщения.
 */

import * as vscode from 'vscode';

import type { DiffEditorPort, PreviewFileForUi } from './diffController';

const SCHEME = 'dsh-diff';

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

/** Редактор VS Code: виртуальные документы, WorkspaceEdit, сообщения. */
export class VscodeDiffEditor implements DiffEditorPort {
  readonly #provider = new DiffPreviewContentProvider();
  readonly #registration: vscode.Disposable;
  readonly #previewUris: vscode.Uri[] = [];

  constructor(context: vscode.ExtensionContext) {
    this.#registration = vscode.workspace.registerTextDocumentContentProvider(
      SCHEME,
      this.#provider
    );
    context.subscriptions.push(this.#registration);
  }

  async showDiff(files: readonly PreviewFileForUi[]): Promise<void> {
    for (const file of files) {
      const baseUri = vscode.Uri.file(file.path);
      const previewUri = vscode.Uri.parse(`${SCHEME}:${file.relativePath}`).with({
        query: `v=${file.newHash}`
      });
      this.#previewUris.push(previewUri);
      this.#provider.set(previewUri, file.newContent);
      await vscode.commands.executeCommand(
        'vscode.diff',
        baseUri,
        previewUri,
        `DSH: ${file.relativePath}`
      );
    }
  }

  async applyBatch(
    files: readonly {
      readonly path: string;
      readonly content: string;
      readonly created: boolean;
    }[]
  ): Promise<boolean> {
    // Один WorkspaceEdit на всю пачку — одна транзакция и один undo-шаг.
    const edit = new vscode.WorkspaceEdit();
    for (const file of files) {
      await this.#addContentToEdit(edit, file.path, file.content, file.created);
    }
    return vscode.workspace.applyEdit(edit);
  }

  async restore(
    files: readonly {
      readonly path: string;
      readonly originalContent: string;
      readonly created: boolean;
    }[]
  ): Promise<boolean> {
    const edit = new vscode.WorkspaceEdit();
    for (const file of files) {
      const uri = vscode.Uri.file(file.path);
      if (file.created) {
        edit.deleteFile(uri, { ignoreIfNotExists: true });
        continue;
      }
      await this.#addContentToEdit(edit, file.path, file.originalContent, false);
    }
    return vscode.workspace.applyEdit(edit);
  }

  async #addContentToEdit(
    edit: vscode.WorkspaceEdit,
    filePath: string,
    content: string,
    created: boolean
  ): Promise<void> {
    const uri = vscode.Uri.file(filePath);
    if (created) {
      edit.createFile(uri, { overwrite: true, contents: Buffer.from(content, 'utf8') });
      return;
    }
    const document = await vscode.workspace.openTextDocument(uri);
    // Полная замена содержимого: точный newContent (включая хвостовой
    // перевод строки и CRLF), undo редактора возвращает исходное.
    const lastLine = document.lineAt(Math.max(0, document.lineCount - 1));
    edit.replace(uri, new vscode.Range(new vscode.Position(0, 0), lastLine.range.end), content);
  }

  clearPreviews(): void {
    for (const uri of this.#previewUris.splice(0)) {
      this.#provider.clear(uri);
    }
  }

  showError(message: string): void {
    void vscode.window.showErrorMessage(`DSH: ${message}`);
  }

  showInfo(message: string): void {
    void vscode.window.showInformationMessage(`DSH: ${message}`);
  }

  dispose(): void {
    this.clearPreviews();
    this.#registration.dispose();
  }
}

