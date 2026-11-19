import assert from 'node:assert/strict';
import { register } from 'node:module';
import test from 'node:test';

register('./helpers/ts-loader.mjs', import.meta.url);
const { ChatViewProvider } = await import('../extension/src/views/chatViewProvider.ts');

function createProvider() {
  return new ChatViewProvider({
    extensionUri: { path: '/ext', fsPath: '/ext', toString: () => 'file:///ext' },
    state: () => ({
      workspaceName: 'ws',
      model: 'deepseek-chat',
      sandbox: 'workspace-write',
      approval: 'ask',
      locale: 'ru'
    })
  });
}

test('boardOpen до resolve view ставится в очередь и уходит после ready', async () => {
  const provider = createProvider();
  const posted = [];
  let listener;
  const view = {
    webview: {
      options: {},
      html: '',
      cspSource: 'vscode-resource:',
      asWebviewUri: (uri) => uri,
      postMessage: async (message) => {
        posted.push(message);
        return true;
      },
      onDidReceiveMessage(callback) {
        listener = callback;
        return { dispose() {} };
      }
    },
    onDidDispose: () => ({ dispose() {} })
  };

  // Команда сработала раньше, чем VS Code resolve-нул view.
  await provider.postMessage({ type: 'boardOpen', data: { columns: [], plugin: {}, empty: true } });
  assert.equal(posted.length, 0, 'до resolve ничего не отправлено');

  provider.resolveWebviewView(view);
  // Второе окно гонки: view resolved, но webview ещё не прислал ready.
  await provider.postMessage({
    type: 'boardOpen',
    data: { columns: [], plugin: {}, empty: true, marker: 'after-resolve' }
  });
  assert.equal(posted.length, 0, 'до ready сообщения не теряются и не отправляются');

  await listener({ type: 'ready' });
  await new Promise((resolve) => setImmediate(resolve));
  const boards = posted.filter((message) => message.type === 'boardOpen');
  assert.equal(boards.length, 2, 'оба boardOpen доставлены после ready');
  assert.equal(boards[1].data.marker, 'after-resolve');
  provider.dispose();
});
