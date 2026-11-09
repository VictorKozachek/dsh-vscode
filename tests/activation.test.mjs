import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
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
function createFakeVscode({ settings = {} } = {}) {
  const state = {
    statusBar: undefined,
    output: [],
    messages: [],
    errors: [],
    executed: [],
    commands: new Map(),
    changeListeners: [],
    viewProviders: new Map(),
    settings,
    workspaceFolders: [{ name: 'demo-project', index: 0 }]
  };

  const fake = {
    StatusBarAlignment: { Left: 1, Right: 2 },
    env: { language: 'ru' },
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
      },
      async showErrorMessage(message) {
        state.errors.push(message);
        return undefined;
      },
      registerWebviewViewProvider(viewType, provider) {
        state.viewProviders.set(viewType, provider);
        return { dispose() {} };
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
      getConfiguration(section) {
        return {
          get(key) {
            return state.settings[`${section}.${key}`];
          }
        };
      },
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
    'dsh.pruneWorkspaces',
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

test('активация: панель dsh.chat зарегистрирована', () => {
  const { fake, state } = createFakeVscode();
  const extension = loadExtensionWithFakeVscode(fake);
  const context = { subscriptions: [] };

  extension.activate(context);

  const provider = state.viewProviders.get('dsh.chat');
  assert.ok(provider, 'провайдер панели должен быть зарегистрирован');
  assert.equal(typeof provider.resolveWebviewView, 'function');
  assert.equal(typeof provider.dispose, 'function');
});

test('активация: DSH: Prune Workspaces чистит реестр по настройкам', async () => {
  const directory = await realpath(
    await mkdtemp(path.join(os.tmpdir(), 'dsh-prune-command-'))
  );

  try {
    // Старая запись (90+ дней) и файл-карантин не должны мешать GC.
    const oldId = '00000000000000aa';
    await mkdir(directory, { recursive: true });
    await writeFile(
      path.join(directory, `${oldId}.json`),
      JSON.stringify({
        version: 2,
        id: oldId,
        path: '/Users/victor/projects/old',
        name: 'old',
        remote: 'local',
        gitRemote: null,
        lastOpenedAt: '2020-01-01T00:00:00.000Z',
        lastSessionId: null,
        defaultModel: null,
        sandboxMode: null,
        approvalPolicy: null,
        contextSnapshot: null
      }),
      'utf8'
    );

    const { fake, state } = createFakeVscode({
      settings: {
        'dsh.workspace.registryPath': directory,
        'dsh.workspace.keepDays': 30
      }
    });
    const extension = loadExtensionWithFakeVscode(fake);
    extension.activate({ subscriptions: [] });

    await state.commands.get('dsh.pruneWorkspaces')();

    assert.equal(state.errors.length, 0);
    assert.match(state.messages.at(-1), /DSH: удалено записей реестра — 1/);
    assert.deepEqual(await readdir(directory), []);
    assert.ok(state.output.some((line) => line.includes(oldId)));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
