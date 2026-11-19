/** Минимальный vscode для unit-теста ChatViewProvider без extension host. */
export const Uri = {
  joinPath: (base, ...parts) => ({
    ...base,
    path: [base.path, ...parts].join('/'),
    fsPath: [base.fsPath, ...parts].join('/'),
    toString: () => `file://${[base.fsPath, ...parts].join('/')}`
  }),
  parse: (value) => ({ path: value, fsPath: value, toString: () => value })
};
export const workspace = {
  fs: {
    async readFile() {
      return new TextEncoder().encode('<html><body></body></html>');
    }
  }
};
export const ViewColumn = { Active: -1, Beside: -2 };
export default { Uri, workspace, ViewColumn };
