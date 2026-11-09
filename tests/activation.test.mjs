import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const moduleApi = require('node:module');

/**
 * Активация расширения без запуска VS Code: подменяем `vscode` на заглушку,
 * которая записывает созданные элементы UI и зарегистрированные команды.
 */
function createFakeVscode() {
  const state = {
    statusBar: undefined,
    output: [],
    messages: [],
    executed: [],
    commands: new Map(),
    changeListeners: [],
    workspaceFolders: [{ name: 'demo-project', index: 0 }]
  };

  const fake = {
    StatusBarAlignment: { Left: 1, Right: 2 },
    window: {
      createStatusBarItem(id, alignment, priority) {
        const item = {
          id,
          alignment,
          priority,
          text: '',
          name: '',
          tooltip: '',
          command: '',
          visible: false,
          show() {
            this.visible = true;
          },
          hide() {
            this.visible = false;
          },
          dispose() {
            this.disposed = true;
          }
        };
        state.statusBar = item;
        return item;
      },
      createOutputChannel(name) {
        return {
          name,
          appendLine(line) {
            state.output.push(line);
          },
          dispose() {}
        };
      },
      async showInformationMessage(message) {
        state.messages.push(message);
        return undefined;
      }
    },
    commands: {
      registerCommand(id, handler) {
        state.commands.set(id, handler);
        return { dispose() {} };
      },
      async executeCommand(id, ...args) {
        state.executed.push({ id, args });
        return undefined;
      }
    },
    workspace: {
      get workspaceFolders() {
        return state.workspaceFolders;
      },
      name: 'demo-project',
      onDidChangeWorkspaceFolders(listener) {
        state.changeListeners.push(listener);
        return { dispose() {} };
      }
    }
  };

  return { fake, state };
}

function loadExtensionWithFakeVscode(fake) {
  const bundlePath = path.join(repoRoot, 'extension', 'dist', 'extension.js');
  // Бандл держит `require('vscode')` в кэше модуля, поэтому каждый тест
  // загружает его заново со своей заглушкой.
  delete require.cache[bundlePath];

  const originalLoad = moduleApi._load;
  moduleApi._load = function load(request, ...rest) {
    if (request === 'vscode') {
      return fake;
    }
    return originalLoad.call(this, request, ...rest);
  };
  try {
    return require(bundlePath);
  } finally {
    moduleApi._load = originalLoad;
  }
}

test('активация: статус-бар показывает имя открытой папки', () => {
  const { fake, state } = createFakeVscode();
  const extension = loadExtensionWithFakeVscode(fake);
  const context = { subscriptions: [] };

  extension.activate(context);

  assert.equal(state.statusBar.text, 'DSH · demo-project · idle');
  assert.equal(state.statusBar.visible, true);

  state.workspaceFolders = [{ name: 'other-project', index: 0 }];
  for (const listener of state.changeListeners) {
    listener({ added: [], removed: [] });
  }
  assert.equal(state.statusBar.text, 'DSH · other-project · idle');

  extension.deactivate();
  assert.equal(state.statusBar.disposed, true);
});

test('активация: все команды каркаса зарегистрированы и вызываются без ошибок', async () => {
  const { fake, state } = createFakeVscode();
  const extension = loadExtensionWithFakeVscode(fake);
  const context = { subscriptions: [] };

  extension.activate(context);

  const commandIds = [...state.commands.keys()].sort();
  assert.deepEqual(commandIds, [
    'dsh.newSession',
    'dsh.openSettings',
    'dsh.openTaskBoard',
    'dsh.reloadContext',
    'dsh.resumeLastSession',
    'dsh.showContextInspector',
    'dsh.stopAgent',
    'dsh.switchWorkspace'
  ]);

  await state.commands.get('dsh.newSession')();
  assert.match(state.messages.at(-1), /DSH: New Session/);

  await state.commands.get('dsh.openSettings')();
  assert.deepEqual(state.executed.at(-1), {
    id: 'workbench.action.openSettings',
    args: ['dsh']
  });

  assert.ok(state.output.some((line) => line.includes('demo-project')));
  assert.ok(context.subscriptions.length >= 10, 'подписки должны попадать в context.subscriptions');
});
