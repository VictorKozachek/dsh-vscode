import assert from 'node:assert/strict';
import { stat, readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  EXTENSION_MESSAGE_TYPES,
  WEBVIEW_MESSAGE_TYPES,
  buildChatViewHtml,
  escapeHtml,
  extractViteAssets,
  parseWebviewMessage,
  renderChatViewHtml,
  renderChatViewNoticeHtml
} from '../extension/src/views/chatHtml.ts';
import {
  EXTENSION_MESSAGE_TYPES as WEBVIEW_EXTENSION_MESSAGE_TYPES,
  WEBVIEW_MESSAGE_TYPES as WEBVIEW_WEBVIEW_MESSAGE_TYPES
} from '../webview/src/messages.ts';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const VITE_HTML = `<!doctype html>
<html lang="ru">
  <head>
    <meta charset="UTF-8" />
    <title>DSH</title>
    <script type="module" crossorigin src="./assets/index.js"></script>
    <link rel="stylesheet" crossorigin href="./assets/index.css">
  </head>
  <body><div id="root"></div></body>
</html>`;

test('parseWebviewMessage: схемы сообщений из WebView', () => {
  assert.deepEqual(parseWebviewMessage({ type: 'ready' }), { kind: 'ready' });
  assert.deepEqual(parseWebviewMessage({ type: 'stop' }), { kind: 'stop' });
  assert.deepEqual(parseWebviewMessage({ type: 'sendMessage', text: '  привет  ' }), {
    kind: 'sendMessage',
    text: 'привет'
  });

  assert.equal(parseWebviewMessage({ type: 'sendMessage', text: '   ' }), null);
  assert.equal(parseWebviewMessage({ type: 'sendMessage' }), null);
  assert.equal(parseWebviewMessage({ type: 'unknown' }), null);
  assert.equal(parseWebviewMessage(null), null);
  assert.equal(parseWebviewMessage(42), null);
  assert.equal(parseWebviewMessage(['ready']), null);
});

test('extractViteAssets: находит скрипт и стили собранного index.html', () => {
  assert.deepEqual(extractViteAssets(VITE_HTML), {
    script: './assets/index.js',
    style: './assets/index.css'
  });

  assert.deepEqual(extractViteAssets('<html><body>пусто</body></html>'), {
    script: null,
    style: null
  });

  assert.deepEqual(
    extractViteAssets('<link href="./assets/a.css" rel="stylesheet"><script src="b.js"></script>'),
    { script: 'b.js', style: './assets/a.css' }
  );
});

test('renderChatViewHtml: CSP с nonce, внешние ассеты, без инлайновых скриптов', () => {
  const html = renderChatViewHtml({
    cspSource: 'https://file+.vscode-resource.vscode-cdn.net',
    nonce: 'abc123',
    scriptUri: 'https://cdn/assets/index.js',
    styleUri: 'https://cdn/assets/index.css',
    title: 'DSH'
  });

  assert.match(html, /Content-Security-Policy/);
  assert.match(html, /default-src 'none'/);
  assert.match(html, /script-src 'nonce-abc123'/);
  assert.match(html, /<script type="module" nonce="abc123" src="https:\/\/cdn\/assets\/index\.js"><\/script>/);
  assert.match(html, /<link rel="stylesheet" nonce="abc123" href="https:\/\/cdn\/assets\/index\.css" \/>/);
  assert.match(html, /<div id="root"><\/div>/);
  assert.doesNotMatch(html, /unsafe-eval/);
  // Инлайнового скрипта без nonce быть не должно.
  const scripts = [...html.matchAll(/<script\b[^>]*>/g)].map((match) => match[0]);
  assert.equal(scripts.length, 1);
  assert.match(scripts[0], /nonce="abc123"/);
});

test('renderChatViewHtml: заголовок и URI экранируются, lang настраивается', () => {
  const html = renderChatViewHtml({
    cspSource: 'https://cdn',
    nonce: 'n"1',
    scriptUri: 'https://cdn/a.js?x="1"',
    styleUri: null,
    title: '<script>alert(1)</script>',
    lang: 'en'
  });

  assert.match(html, /<html lang="en">/);
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.doesNotMatch(html, /<script>alert/);
  assert.doesNotMatch(html, /<link rel="stylesheet"/, 'без styleUri тега стилей нет');
  assert.equal(escapeHtml('a"b&c<d>'), 'a&quot;b&amp;c&lt;d&gt;');
});

test('renderChatViewNoticeHtml: заглушка, если webview/dist не собран', () => {
  const html = renderChatViewNoticeHtml({
    cspSource: 'https://cdn',
    title: 'DSH',
    message: 'WebView ещё не собран',
    hint: 'pnpm build',
    lang: 'en'
  });

  assert.match(html, /<html lang="en">/);
  assert.match(html, /WebView ещё не собран/);
  assert.match(html, /pnpm build/);
  assert.match(html, /default-src 'none'/);
});

test('buildChatViewHtml: собирает оболочку из webview/dist с локалью', async () => {
  const html = await buildChatViewHtml({
    cspSource: 'https://cdn',
    nonce: 'nonce-1',
    locale: 'en',
    readIndexHtml: async () => VITE_HTML,
    toWebviewUri: (relative) => `https://cdn/${relative.replace(/^\.?\//, '')}`
  });

  assert.match(html, /<html lang="en">/);
  assert.match(html, /script-src 'nonce-nonce-1'/);
  assert.match(html, /src="https:\/\/cdn\/assets\/index\.js"/);
  assert.match(html, /href="https:\/\/cdn\/assets\/index\.css"/);
});

test('buildChatViewHtml: нет index.html или скрипта — заглушка с локалью', async () => {
  const missing = await buildChatViewHtml({
    cspSource: 'https://cdn',
    nonce: 'n',
    locale: 'en',
    readIndexHtml: async () => null,
    toWebviewUri: (relative) => relative
  });
  assert.match(missing, /<html lang="en">/);
  assert.match(missing, /WebView ещё не собран/);
  assert.doesNotMatch(missing, /<script/);

  const broken = await buildChatViewHtml({
    cspSource: 'https://cdn',
    nonce: 'n',
    locale: 'ru',
    readIndexHtml: async () => '<html><body>без скрипта</body></html>',
    toWebviewUri: (relative) => relative
  });
  assert.match(broken, /<html lang="ru">/);
  assert.match(broken, /WebView ещё не собран/);

  const throwing = await buildChatViewHtml({
    cspSource: 'https://cdn',
    nonce: 'n',
    locale: 'ru',
    readIndexHtml: async () => {
      throw new Error('нет доступа');
    },
    toWebviewUri: (relative) => relative
  });
  assert.match(throwing, /WebView ещё не собран/);
});

test('контракт сообщений extension и webview совпадает', () => {
  assert.deepEqual([...WEBVIEW_MESSAGE_TYPES].sort(), [...WEBVIEW_WEBVIEW_MESSAGE_TYPES].sort());
  assert.deepEqual([...EXTENSION_MESSAGE_TYPES].sort(), [...WEBVIEW_EXTENSION_MESSAGE_TYPES].sort());
});

test('манифест: контейнер DSH в activity bar и view dsh.chat', async () => {
  const manifest = JSON.parse(
    await readFile(path.join(repoRoot, 'extension', 'package.json'), 'utf8')
  );

  const containers = manifest.contributes.viewsContainers.activitybar;
  const container = containers.find((item) => item.id === 'dsh');
  assert.deepEqual(container, { id: 'dsh', title: 'DSH', icon: 'media/dsh.svg' });
  assert.ok(await stat(path.join(repoRoot, 'extension', container.icon)), 'иконка контейнера существует');

  const views = manifest.contributes.views.dsh;
  assert.deepEqual(
    views.map((view) => view.id).sort(),
    ['dsh.chat', 'dsh.context', 'dsh.kanban', 'dsh.sessions'],
    'в контейнере DSH чат, инспектор контекста (#013) и сессии (#022)'
  );
  const chat = views.find((view) => view.id === 'dsh.chat');
  assert.equal(chat.type, 'webview');
  const context = views.find((view) => view.id === 'dsh.context');
  assert.equal(context.type, 'tree');
  const kanban = views.find((view) => view.id === 'dsh.kanban');
  assert.equal(kanban.type, 'tree');
  const sessions = views.find((view) => view.id === 'dsh.sessions');
  assert.equal(sessions.type, 'tree');
  assert.equal(sessions.name, 'Sessions');
  assert.equal(sessions.icon, 'media/dsh.svg');

  const commands = manifest.contributes.commands;
  const create = commands.find((command) => command.command === 'dsh.sessions.create');
  const refresh = commands.find((command) => command.command === 'dsh.sessions.refresh');
  assert.equal(create.icon, '$(add)');
  assert.equal(refresh.icon, '$(refresh)');

  const welcome = manifest.contributes.viewsWelcome.find(
    (entry) => entry.view === 'dsh.sessions' && entry.when === 'dsh.sessions.error'
  );
  assert.ok(welcome, 'viewsWelcome для ошибки есть');
  assert.match(welcome.contents, /dsh\.openSettings/);
});
