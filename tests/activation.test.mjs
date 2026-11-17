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
    webviewMessages: [],
    webviewListeners: [],
    settings,
    workspaceFolders: [{ name: 'demo-project', index: 0, uri: { fsPath: '/demo-project' } }]
  };

  const fake = {
    StatusBarAlignment: { Left: 1, Right: 2 },
    Uri: {
      joinPath(uri, ...parts) {
        const joined = [uri.path, ...parts].join('/');
        return { path: joined, fsPath: joined, toString: () => `file://${joined}` };
      },
      file(filePath) {
        return { path: filePath, fsPath: filePath, toString: () => `file://${filePath}` };
      },
      parse(value) {
        return { path: value, fsPath: value, toString: () => value };
      }
    },
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
      fs: {
        async readFile() {
          throw new Error('ENOENT');
        }
      },
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

function resolveChatView(state) {
  const provider = state.viewProviders.get('dsh.chat');
  const view = {
    webview: {
      options: {},
      html: '',
      cspSource: 'vscode-resource:',
      async postMessage(message) {
        state.webviewMessages.push(message);
        return true;
      },
      onDidReceiveMessage(listener) {
        state.webviewListeners.push(listener);
        return { dispose() {} };
      },
      asWebviewUri(uri) {
        return { toString: () => uri.toString() };
      }
    },
    onDidDispose() {
      return { dispose() {} };
    }
  };
  provider.resolveWebviewView(view);
  return view;
}

const tick = () => new Promise((resolve) => setImmediate(resolve));

test('активация: New Session открывает форму и создаёт сессию с выбором', async () => {
  const { fake, state } = createFakeVscode({
    settings: { 'dsh.defaultModel': 'deepseek-v4' }
  });
  const extension = loadExtensionWithFakeVscode(fake);
  const globalState = new Map();
  const context = {
    subscriptions: [],
    extensionUri: { path: '/ext', fsPath: '/ext', toString: () => 'file:///ext' },
    globalState: {
      get(key, fallback) {
        return globalState.has(key) ? globalState.get(key) : fallback;
      },
      async update(key, value) {
        globalState.set(key, value);
      }
    }
  };
  extension.activate(context);
  resolveChatView(state);

  const created = [];
  extension.setSessionManager({
    state: { workspaceId: 'ws', sessionId: null, title: null, status: 'idle', turnId: null, updatedAt: '' },
    async create(options) {
      created.push(options);
      return { sessionId: 'sess-1', title: options.title ?? null };
    },
    on() {
      return { dispose() {} };
    },
    async list() {
      return [];
    }
  });

  await state.commands.get('dsh.newSession')();
  await tick();
  const open = state.webviewMessages.find((message) => message.type === 'newSessionOpen');
  assert.ok(open, 'форма открыта');
  assert.equal(open.form.values.model, 'deepseek-v4');
  const standard = open.form.presets.find((preset) => preset.id === 'standard');
  assert.ok(standard, 'standard есть в форме');
  assert.equal(standard.description, undefined, 'без русского описания для en-UI');

  await state.webviewListeners.at(-1)({
    type: 'newSessionSubmit',
    values: {
      preset: 'standard',
      model: 'deepseek-v4',
      sandbox: 'danger-full-access',
      approval: 'never',
      title: '',
      confirmDanger: true
    }
  });
  await tick();
  await tick();

  assert.equal(created.length, 1);
  assert.equal(created[0].preset, 'standard');
  assert.equal(created[0].model, 'deepseek-v4');
  assert.equal(created[0].sandbox, 'danger-full-access');
  assert.equal(created[0].approval, 'never');
  assert.match(created[0].title, /^standard · /);
  assert.ok(state.webviewMessages.some((message) => message.type === 'newSessionClose'));
  assert.deepEqual(globalState.get('dsh.newSession.last'), {
    preset: 'standard',
    model: 'deepseek-v4',
    sandbox: 'danger-full-access',
    approval: 'never'
  });
});

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
    'dsh.revertLastEdit',
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

test('активация: форма восстанавливает последнюю выбранную модель из globalState', async () => {
  const { fake, state } = createFakeVscode({
    settings: { 'dsh.defaultModel': 'deepseek-chat', 'dsh.models': ['custom-model'] }
  });
  const extension = loadExtensionWithFakeVscode(fake);
  const globalState = new Map([
    ['dsh.newSession.last', { preset: 'standard', model: 'custom-model', sandbox: 'read-only', approval: 'never' }]
  ]);
  const context = {
    subscriptions: [],
    extensionUri: { path: '/ext', fsPath: '/ext', toString: () => 'file:///ext' },
    globalState: {
      get(key, fallback) {
        return globalState.has(key) ? globalState.get(key) : fallback;
      },
      async update(key, value) {
        globalState.set(key, value);
      }
    }
  };
  extension.activate(context);
  resolveChatView(state);
  extension.setSessionManager({
    state: { workspaceId: 'ws', sessionId: null, title: null, status: 'idle', turnId: null, updatedAt: '' },
    async create() {
      return { sessionId: 'sess-1' };
    },
    on() {
      return { dispose() {} };
    },
    async list() {
      return [];
    }
  });

  await state.commands.get('dsh.newSession')();
  await tick();
  const open = state.webviewMessages.find((message) => message.type === 'newSessionOpen');
  assert.equal(open.form.values.model, 'custom-model');
  assert.equal(open.form.values.sandbox, 'read-only');
  assert.equal(open.form.values.approval, 'never');
});
