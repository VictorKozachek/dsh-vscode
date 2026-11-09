/**
 * Сборка extension host одним файлом.
 *
 * `vscode` — единственный внешний модуль: он предоставляется хостом, всё
 * остальное (включая пакеты workspace, например `@dsh-vscode/protocol`)
 * вкомпилируется в `dist/extension.js`.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const packageRoot = path.dirname(fileURLToPath(import.meta.url));
const isProduction = process.env['NODE_ENV'] !== 'development';

await build({
  entryPoints: [path.join(packageRoot, 'src', 'extension.ts')],
  outfile: path.join(packageRoot, 'dist', 'extension.js'),
  bundle: true,
  format: 'cjs',
  platform: 'node',
  target: 'node20',
  external: ['vscode'],
  sourcemap: !isProduction,
  minify: isProduction,
  logLevel: 'info'
});
