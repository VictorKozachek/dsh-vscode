#!/usr/bin/env node
/**
 * Копирует собранный WebView (`webview/dist`) в расширение
 * (`extension/dist/webview`), откуда его читает `ChatViewProvider`.
 *
 * Панель ищет ассеты относительно `context.extensionUri`, поэтому копия нужна
 * и в Extension Development Host, и в упакованном VSIX (там `webview/` рядом с
 * `extension/` не поедет).
 */

import { cp, mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const webviewRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = path.join(webviewRoot, 'dist');
const target = path.resolve(webviewRoot, '..', 'extension', 'dist', 'webview');

await rm(target, { recursive: true, force: true });
await mkdir(path.dirname(target), { recursive: true });
await cp(source, target, { recursive: true });
console.log(`webview: ассеты скопированы в ${path.relative(process.cwd(), target)}`);
