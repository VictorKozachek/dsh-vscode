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
    workspaceFolders: [{ name: 'demo-project', index: 0, uri: { fsPath: '/demo-project' } }]
  };

  class FakeTreeItem {
    constructor(label, collapsibleState) {
      this.label = label;
      this.collapsibleState = collapsibleState;
      this.description = '';
      this.tooltip = '';
      this.contextValue = '';
      this.command = undefined;
      this.iconPath = undefined;
      this.id = undefined;
    }
  }
  class FakeThemeIcon {
    constructor(id) {
      this.id = id;
    }
  }

  const fake = {
    StatusBarAlignment: { Left: 1, Right: 2 },
    ConfigurationTarget: { Global: 1, Workspace: 2, WorkspaceFolder: 3 },
    TreeItem: FakeTreeItem,
    TreeItemCollapsibleState: { None: 0, Collapsed: 1, Expanded: 2 },
    ThemeIcon: FakeThemeIcon,
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
      async showWarningMessage(message) {
        state.messages.push(message);
        return undefined;
      },
      async showQuickPick(items) {
        return typeof state.quickPick === 'string' ? state.quickPick : items[0];
      },
      registerWebviewViewProvider(viewType, provider) {
        state.viewProviders.set(viewType, provider);
        return { dispose() {} };
      },
      createTreeView(viewId, options) {
        state.treeViews ??= new Map();
        state.treeViews.set(viewId, options);
        return {
          onDidChangeVisibility(listener) {
            state.treeVisibilityListeners ??= [];
            state.treeVisibilityListeners.push(listener);
            return { dispose() {} };
          },
          dispose() {}
        };
      },
      async showInputBox() {
        return undefined;
      },
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
          },
          async update(key, value) {
            state.settings[`${section}.${key}`] = value;
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
    'dsh.choosePrimaryWorkspace',
    'dsh.newSession',
    'dsh.openSettings',
    'dsh.openTaskBoard',
    'dsh.pruneWorkspaces',
    'dsh.reloadContext',
    'dsh.resumeLastSession',
    'dsh.revertLastEdit',
    'dsh.sessions.create',
    'dsh.sessions.delete',
    'dsh.sessions.openTranscript',
    'dsh.sessions.refresh',
    'dsh.sessions.rename',
    'dsh.sessions.resume',
    'dsh.sessions.select',
    'dsh.sessions.stop',
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

test('Sessions «+» открывает диалог New Session (#023), а не inputBox', async () => {
  const { fake, state } = createFakeVscode();
  const extension = loadExtensionWithFakeVscode(fake);
  extension.activate({ subscriptions: [] });

  await state.commands.get('dsh.sessions.create')();
  assert.ok(
    state.executed.some((item) => item.id === 'dsh.newSession'),
    'вызван dsh.newSession'
  );
  extension.deactivate();
});

test('активация: рантайм #021 создаётся из настроек, без спавна при старте', () => {
  const { fake, state } = createFakeVscode({
    settings: { 'dsh.executablePath': 'dsh', 'dsh.profile': 'acp' }
  });
  const extension = loadExtensionWithFakeVscode(fake);
  extension.activate({ subscriptions: [] });

  const runtime = extension.getDshRuntime();
  assert.ok(runtime, 'рантайм создан');
  assert.equal(runtime.state, 'stopped', 'без спавна при активации');
  assert.equal(runtime.diagnostics.state, 'stopped');
  assert.equal(state.errors.length, 0);
  extension.deactivate();
  assert.equal(extension.getDshRuntime(), undefined);
});

test('активация: рантайм #021 стартует из Extension Host, session.list/create, stop', async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), 'dsh-activation-runtime-'));
  const { fake, state } = createFakeVscode({
    settings: {
      'dsh.executablePath': path.resolve('tests/fixtures/fake-acp-runtime.mjs'),
      'dsh.profile': 'acp'
    }
  });
  state.workspaceFolders = [{ name: 'ws', index: 0, uri: { fsPath: workspace } }];
  const extension = loadExtensionWithFakeVscode(fake);
  extension.activate({ subscriptions: [] });

  const runtime = extension.getDshRuntime();
  assert.ok(runtime, 'рантайм создан в активации');
  await runtime.start();
  assert.equal(runtime.state, 'running', runtime.diagnostics.message);
  assert.match(state.statusBar.text, /ACP 9\.9\.9/, 'версия ACP в статус-баре');

  const listed = await runtime.request('session.list', { workspaceId: 'ws' });
  assert.ok(Array.isArray(listed.sessions));
  const created = await runtime.request('session.create', { workspaceId: 'ws' });
  assert.match(created.sessionId, /sess-/);

  await runtime.stop();
  assert.equal(runtime.state, 'stopped');
  extension.deactivate();
  await rm(workspace, { recursive: true, force: true });
});


test('multi-root: primary из настройки виден в статус-баре и выбирается командой', async () => {
  const { fake, state } = createFakeVscode({
    settings: { 'dsh.primaryWorkspace': 'second' }
  });
  state.workspaceFolders = [
    { name: 'first', index: 0 },
    { name: 'second', index: 1 }
  ];
  const extension = loadExtensionWithFakeVscode(fake);
  extension.activate({ subscriptions: [] });
  assert.equal(state.statusBar.text, 'DSH · second · idle');

  state.quickPick = 'first';
  await state.commands.get('dsh.choosePrimaryWorkspace')();
  assert.equal(state.settings['dsh.primaryWorkspace'], 'first');
  assert.equal(state.statusBar.text, 'DSH · first · idle');
});
