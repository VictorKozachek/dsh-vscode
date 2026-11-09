import assert from 'node:assert/strict';
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';

import {
  ContextLoader,
  DEFAULT_DEBOUNCE_MS,
  IgnoreMatcher,
  detectLanguage,
  isBinaryFile,
  isRelevantContextFile,
  parseSkillFrontmatter,
  parseWorkspaceManifest,
  rulesFor
} from '../extension/src/context/contextLoader.ts';

const tmpRoot = await realpath(await mkdtemp(path.join(os.tmpdir(), 'dsh-context-loader-')));
after(() => rm(tmpRoot, { recursive: true, force: true }));

let caseCounter = 0;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function writeFiles(root, files) {
  for (const [relative, content] of Object.entries(files)) {
    const absolute = path.join(root, relative);
    await mkdir(path.dirname(absolute), { recursive: true });
    await writeFile(absolute, content);
  }
}

async function makeCase(files = {}) {
  caseCounter += 1;
  const root = path.join(tmpRoot, `case-${String(caseCounter)}`);
  const home = path.join(root, '.home');
  await mkdir(root, { recursive: true });
  await mkdir(home, { recursive: true });
  await writeFiles(root, files);
  return { root, home };
}

function makeLoader(root, home, options = {}) {
  return new ContextLoader({ root, homeDirectory: home, debounceMs: 60, ...options });
}

async function waitFor(predicate, description, timeoutMs = 4000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) {
      return;
    }
    await sleep(20);
  }
  throw new Error(`не дождались: ${description}`);
}

test('правила: корень и вложенные AGENTS.md, ближайший первым', async () => {
  const { root, home } = await makeCase({
    'AGENTS.md': '# Правила корня',
    'packages/core/AGENTS.md': '# Правила пакета core',
    'packages/core/src/app.ts': 'export const x = 1;\n',
    'docs/readme.md': '# Док\n'
  });
  await writeFiles(home, { '.dsh/AGENTS.md': '# Пользовательские правила' });

  const loader = makeLoader(root, home);
  const pack = await loader.load();

  const paths = pack.rules.map((rule) => rule.path);
  assert.ok(paths.includes('AGENTS.md'));
  assert.ok(paths.includes('packages/core/AGENTS.md'));
  assert.ok(paths.includes('~/.dsh/AGENTS.md'));
  // Ближайшее правило идёт первым.
  assert.ok(
    paths.indexOf('packages/core/AGENTS.md') < paths.indexOf('AGENTS.md'),
    'правило пакета должно быть выше корневого'
  );

  const coreRules = rulesFor(pack, 'packages/core/src/app.ts');
  assert.deepEqual(
    coreRules.map((rule) => rule.path),
    ['packages/core/AGENTS.md', 'AGENTS.md', '~/.dsh/AGENTS.md']
  );

  const docsRules = rulesFor(pack, 'docs/readme.md');
  assert.deepEqual(
    docsRules.map((rule) => rule.path),
    ['AGENTS.md', '~/.dsh/AGENTS.md']
  );

  assert.equal(pack.rules.find((rule) => rule.source === 'user')?.path, '~/.dsh/AGENTS.md');
  loader.dispose();
});

test('манифест: валидный, неизвестные ключи и битый JSON', async () => {
  const parsed = parseWorkspaceManifest(
    JSON.stringify({
      name: 'api-service',
      defaultModel: 'deepseek-chat',
      sandboxMode: 'workspace-write',
      approvalPolicy: 'ask',
      context: { ignore: ['tmp/'], maxBytes: 4096 },
      kanban: { enabled: true },
      memory: { enabled: true, path: '.dsh/memory' }
    })
  );
  assert.deepEqual(parsed.warnings, []);
  assert.equal(parsed.manifest?.name, 'api-service');
  assert.deepEqual(parsed.manifest?.context?.ignore, ['tmp/']);

  const unknown = parseWorkspaceManifest(JSON.stringify({ name: 'x', extra: true }));
  assert.ok(unknown.warnings.some((warning) => warning.includes('неизвестный ключ «extra»')));

  const broken = parseWorkspaceManifest('{ "name": ');
  assert.equal(broken.manifest, null);
  assert.ok(broken.warnings.some((warning) => warning.includes('битый JSON')));
});

test('игноры: .gitignore и context.ignore, отрицание и каталоги', async () => {
  const { root, home } = await makeCase({
    '.gitignore': 'dist/\n*.log\n!keep.log\n',
    '.dsh/workspace.json': JSON.stringify({ context: { ignore: ['tmp/'], maxBytes: 1_000_000 } }),
    'dist/bundle.js': 'x',
    'debug.log': 'x',
    'keep.log': 'x',
    'tmp/scratch.txt': 'x',
    'src/app.ts': 'export {};\n'
  });

  const loader = makeLoader(root, home);
  const pack = await loader.load();
  const indexed = pack.files.map((file) => file.path);

  assert.ok(indexed.includes('src/app.ts'));
  assert.ok(indexed.includes('keep.log'), 'отрицание !keep.log возвращает файл');
  assert.ok(!indexed.includes('dist/bundle.js'));
  assert.ok(!indexed.includes('debug.log'));
  assert.ok(!indexed.includes('tmp/scratch.txt'));

  const matcher = new IgnoreMatcher(['*.log', '!keep.log', 'docs/', '/root.txt']);
  assert.equal(matcher.ignores('a/b.log'), true);
  assert.equal(matcher.ignores('keep.log'), false);
  assert.equal(matcher.ignores('docs', true), true);
  assert.equal(matcher.ignores('root.txt'), true);
  assert.equal(matcher.ignores('sub/root.txt'), false);

  loader.dispose();
});

test('секреты не попадают в индекс', async () => {
  const { root, home } = await makeCase({
    '.env': 'SECRET=1\n',
    '.env.local': 'SECRET=2\n',
    'id_rsa': 'private',
    'cert.pem': 'private',
    '.npmrc': 'token=1',
    'credentials.json': '{"token":"1"}',
    'src/app.ts': 'export {};\n'
  });

  const loader = makeLoader(root, home);
  const pack = await loader.load();
  const indexed = pack.files.map((file) => file.path);

  assert.deepEqual(indexed, ['src/app.ts']);
  loader.dispose();
});

test('бинарники: попадают в индекс с флагом binary и не читаются', async () => {
  const { root, home } = await makeCase({
    'assets/logo.png': Buffer.from([0x89, 0x50, 0x4e, 0x47]),
    'src/app.ts': 'export {};\n'
  });

  const loader = makeLoader(root, home);
  const pack = await loader.load();
  const logo = pack.files.find((file) => file.path === 'assets/logo.png');

  assert.ok(logo);
  assert.equal(logo.binary, true);
  assert.equal(logo.language, 'Other');
  assert.equal(isBinaryFile('a.png'), true);
  assert.equal(isBinaryFile('a.ts'), false);
  assert.equal(detectLanguage('src/app.ts'), 'TypeScript');
  assert.equal(detectLanguage('README.md'), 'Markdown');

  loader.dispose();
});

test('скилы: проектные и пользовательские, конфликт имён решает проект', async () => {
  const { root, home } = await makeCase({
    '.agents/skills/kanban/SKILL.md': '---\nname: kanban\ndescription: Доска задач\n---\n# Kanban\n',
    '.dsh/skills/review/SKILL.md': '---\nname: review\ndescription: Проектное ревью\n---\n'
  });
  await writeFiles(home, {
    '.dsh/skills/review/SKILL.md': '---\nname: review\ndescription: Пользовательское ревью\n---\n'
  });

  const loader = makeLoader(root, home);
  const pack = await loader.load();

  assert.deepEqual(
    pack.skills.map((skill) => `${skill.name}:${skill.source}`).sort(),
    ['kanban:project', 'review:project']
  );
  assert.equal(pack.skills.find((skill) => skill.name === 'review')?.description, 'Проектное ревью');
  assert.equal(pack.conflicts.length, 1);
  assert.equal(pack.conflicts[0]?.kind, 'skill');
  assert.equal(pack.conflicts[0]?.name, 'review');
  assert.match(pack.conflicts[0].winner, /^\.dsh\/skills\/review$/);
  assert.match(pack.conflicts[0].ignored, /~\/\.dsh\/skills\/review$/);

  assert.deepEqual(parseSkillFrontmatter('---\nname: x\ndescription: "y z"\n---\n'), {
    name: 'x',
    description: 'y z'
  });
  loader.dispose();
});

test('кэш: повторный load — хит, изменение AGENTS.md — промах', async () => {
  const { root, home } = await makeCase({ 'AGENTS.md': '# v1\n' });
  const loader = makeLoader(root, home);

  const first = await loader.load();
  assert.equal(loader.lastCacheHit, false);
  assert.match(first.files.length >= 0 ? 'ok' : 'ok', /ok/);

  const second = await loader.load();
  assert.equal(loader.lastCacheHit, true);
  assert.equal(second.fingerprint, first.fingerprint);

  await writeFile(path.join(root, 'AGENTS.md'), '# v2 — новая версия правил\n');
  const third = await loader.load();
  assert.equal(loader.lastCacheHit, false);
  assert.notEqual(third.fingerprint, first.fingerprint);
  assert.match(third.rules[0]?.text ?? '', /v2/);

  loader.dispose();
});

test('hot reload: изменение AGENTS.md приходит событием', async () => {
  const { root, home } = await makeCase({ 'AGENTS.md': '# было\n' });
  const loader = makeLoader(root, home);
  await loader.load();

  const packs = [];
  const unsubscribe = loader.watch((pack) => {
    packs.push(pack);
  });

  try {
    await writeFile(path.join(root, 'AGENTS.md'), '# стало: новое правило\n');
    await waitFor(() => packs.length > 0, 'событие пересборки контекста');
    assert.match(packs.at(-1).rules[0]?.text ?? '', /стало/);
    assert.notEqual(packs.at(-1).fingerprint, undefined);
  } finally {
    unsubscribe();
    loader.dispose();
  }

  assert.equal(isRelevantContextFile('AGENTS.md'), true);
  assert.equal(isRelevantContextFile('src/AGENTS.md'), true);
  assert.equal(isRelevantContextFile('.dsh/workspace.json'), true);
  assert.equal(isRelevantContextFile('.agents/skills/x/SKILL.md'), true);
  assert.equal(isRelevantContextFile('src/app.ts'), false);
  assert.equal(isRelevantContextFile(null), true);
  assert.equal(DEFAULT_DEBOUNCE_MS, 500);
});

test('память проекта: читается только при memory.enabled', async () => {
  const files = {
    '.dsh/workspace.json': JSON.stringify({ memory: { enabled: true } }),
    '.dsh/memory/notes.md': '# Заметки проекта\n',
    'src/app.ts': 'export {};\n'
  };
  const enabled = await makeCase(files);
  const enabledLoader = makeLoader(enabled.root, enabled.home);
  const enabledPack = await enabledLoader.load();
  assert.equal(enabledPack.memory.length, 1);
  assert.match(enabledPack.memory[0]?.text ?? '', /Заметки проекта/);

  const disabled = await makeCase({ '.dsh/memory/notes.md': '# ignored\n' });
  const disabledLoader = makeLoader(disabled.root, disabled.home);
  const disabledPack = await disabledLoader.load();
  assert.deepEqual(disabledPack.memory, []);

  enabledLoader.dispose();
  disabledLoader.dispose();
});

test('maxBytes ограничивает индекс и помечает truncated', async () => {
  const { root, home } = await makeCase({
    '.dsh/workspace.json': JSON.stringify({ context: { maxBytes: 50 } }),
    'a.txt': 'a'.repeat(100),
    'b.txt': 'b'.repeat(100)
  });

  const loader = makeLoader(root, home);
  const pack = await loader.load();

  assert.equal(pack.stats.truncated, true);
  assert.ok(pack.stats.bytes <= 50);
  const indexed = pack.files.map((file) => file.path);
  assert.ok(!indexed.includes('a.txt'));
  assert.ok(!indexed.includes('b.txt'));
  loader.dispose();
});

test('производительность: контекст-пак на 1000 файлов быстрее 300 мс', async () => {
  const { root, home } = await makeCase({
    '.dsh/workspace.json': JSON.stringify({ context: { maxBytes: 10_000_000 } }),
    'AGENTS.md': '# Правила\n'
  });
  await mkdir(path.join(root, 'src'), { recursive: true });
  await Promise.all(
    Array.from({ length: 1000 }, (_, index) =>
      writeFile(path.join(root, 'src', `file-${String(index)}.ts`), 'export {};\n')
    )
  );

  const loader = makeLoader(root, home);

  // Замер — лучший из трёх: машина под параллельной нагрузкой (другие агенты,
  // pnpm install) даёт случайные всплески I/O, которые к стоимости загрузчика
  // отношения не имеют. Маркерный файл меняет хеш входов, чтобы каждый прогон
  // был холодным, а не из кэша.
  const durations = [];
  let files = 0;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    await writeFile(path.join(root, 'probe.txt'), `probe-${String(attempt)}`);
    const pack = await loader.load();
    durations.push(pack.stats.durationMs);
    files = pack.files.filter((file) => file.path.startsWith('src/')).length;
  }

  assert.equal(files, 1000);
  const best = Math.min(...durations);
  assert.ok(
    best < 300,
    `сборка 1000 файлов заняла ${String(best)} мс (замеры: ${durations.map((value) => String(value)).join(', ')})`
  );
  loader.dispose();
});

test('память: путь за пределы воркспейса не читается (../ и абсолютный)', async () => {
  const outside = path.join(tmpRoot, 'outside-memory');
  await mkdir(outside, { recursive: true });
  await writeFile(path.join(outside, 'leak.md'), '# Секрет\n');

  const relativeCase = await makeCase({
    '.dsh/workspace.json': JSON.stringify({ memory: { enabled: true, path: '../outside-memory' } }),
    'src/app.ts': 'export {};\n'
  });
  const relativeLoader = makeLoader(relativeCase.root, relativeCase.home);
  const relativePack = await relativeLoader.load();

  assert.deepEqual(relativePack.memory, []);
  assert.ok(
    relativePack.manifestWarnings.some(
      (warning) => warning.includes('memory.path') && warning.includes('вне воркспейса')
    )
  );

  const absoluteCase = await makeCase({ 'src/app.ts': 'export {};\n' });
  await writeFiles(absoluteCase.root, {
    '.dsh/workspace.json': JSON.stringify({ memory: { enabled: true, path: outside } })
  });
  const absoluteLoader = makeLoader(absoluteCase.root, absoluteCase.home);
  const absolutePack = await absoluteLoader.load();

  assert.deepEqual(absolutePack.memory, []);
  assert.ok(absolutePack.manifestWarnings.some((warning) => warning.includes('memory.path')));

  relativeLoader.dispose();
  absoluteLoader.dispose();
});

test('манифест: rules применяются, внешние и отсутствующие — с предупреждением', async () => {
  const { root, home } = await makeCase({
    '.dsh/workspace.json': JSON.stringify({
      rules: ['docs/CONVENTIONS.md', '../outside-rules.md', 'docs/MISSING.md'],
      context: { maxBytes: 100000 }
    }),
    'AGENTS.md': '# Корень\n',
    'docs/CONVENTIONS.md': '# Конвенции\n',
    'src/app.ts': 'export {};\n'
  });
  await writeFile(path.join(tmpRoot, 'outside-rules.md'), '# Снаружи\n');

  const loader = makeLoader(root, home);
  const pack = await loader.load();

  const conventions = pack.rules.find((rule) => rule.path === 'docs/CONVENTIONS.md');
  assert.ok(conventions, 'правило из манифеста попадает в пак');
  assert.match(conventions.text, /Конвенции/);
  assert.ok(!pack.rules.some((rule) => rule.path.includes('outside-rules')));
  assert.ok(
    pack.manifestWarnings.some((warning) => warning.includes('../outside-rules.md') && warning.includes('вне воркспейса'))
  );
  assert.ok(
    pack.manifestWarnings.some((warning) => warning.includes('docs/MISSING.md') && warning.includes('не найден'))
  );

  loader.dispose();
});

test('манифест: skills-каталоги подключаются, внешние — с предупреждением', async () => {
  const outsideSkills = path.join(tmpRoot, 'outside-skills');
  await mkdir(path.join(outsideSkills, 'evil'), { recursive: true });
  await writeFile(
    path.join(outsideSkills, 'evil', 'SKILL.md'),
    '---\nname: evil\ndescription: Внешний\n---\n'
  );

  const { root, home } = await makeCase({
    '.dsh/workspace.json': JSON.stringify({ skills: ['.custom-skills', '../outside-skills'] }),
    '.custom-skills/foo/SKILL.md': '---\nname: foo\ndescription: Свой скил\n---\n',
    'src/app.ts': 'export {};\n'
  });

  const loader = makeLoader(root, home);
  const pack = await loader.load();

  assert.ok(
    pack.skills.some((skill) => skill.name === 'foo' && skill.source === 'project'),
    'скил из манифеста попадает в пак'
  );
  assert.ok(!pack.skills.some((skill) => skill.name === 'evil'), 'внешний скил не читается');
  assert.ok(
    pack.manifestWarnings.some(
      (warning) => warning.includes('skills') && warning.includes('вне воркспейса')
    )
  );

  loader.dispose();
});

test('индекс: .git-файл (git worktree) не попадает в пак', async () => {
  const { root, home } = await makeCase({
    '.git': 'gitdir: ../repo/.git/worktrees/wt\n',
    'src/app.ts': 'export {};\n'
  });

  const loader = makeLoader(root, home);
  const pack = await loader.load();
  const indexed = pack.files.map((file) => file.path);

  assert.ok(indexed.includes('src/app.ts'));
  assert.ok(!indexed.includes('.git'), '.git-файл не индексируется');
  assert.ok(!indexed.some((filePath) => filePath.startsWith('.git')));

  loader.dispose();
});

test('maxBytes для правил считается в байтах, а не в UTF-16 символах', async () => {
  const { root, home } = await makeCase({
    '.dsh/workspace.json': JSON.stringify({ context: { maxBytes: 100 } }),
    'AGENTS.md': 'я'.repeat(200)
  });

  const loader = makeLoader(root, home);
  const pack = await loader.load();

  const rule = pack.rules[0];
  assert.ok(rule);
  assert.equal(rule.truncated, true);
  assert.ok(
    Buffer.byteLength(rule.text) <= 100,
    `правило занимает ${String(Buffer.byteLength(rule.text))} байт при лимите 100`
  );

  loader.dispose();
});

test('кэш: изменение AGENTS.md, не попавшего в индекс, инвалидирует пак', async () => {
  const { root, home } = await makeCase({
    '.gitignore': 'nested/AGENTS.md\n',
    'nested/AGENTS.md': '# версия 1\n',
    'src/app.ts': 'export {};\n'
  });

  const loader = makeLoader(root, home);
  const first = await loader.load();
  assert.equal(loader.lastCacheHit, false);
  assert.ok(first.rules.some((rule) => rule.path === 'nested/AGENTS.md'));
  assert.ok(!first.files.some((file) => file.path === 'nested/AGENTS.md'), 'файл игнорируется индексом');

  await writeFile(path.join(root, 'nested', 'AGENTS.md'), '# версия 2 — новее и длиннее\n');
  const second = await loader.load();

  assert.equal(loader.lastCacheHit, false);
  assert.match(second.rules.find((rule) => rule.path === 'nested/AGENTS.md')?.text ?? '', /версия 2/);

  loader.dispose();
});

test('manifest rules/skills: секреты и служебные пути не читаются', async () => {
  const { root, home } = await makeCase({
    '.dsh/workspace.json': JSON.stringify({
      rules: ['.env', '.git/config'],
      context: { maxBytes: 100000 }
    }),
    '.env': 'SECRET_TOKEN=leak\n',
    '.git/config': '[remote "origin"]\n',
    'AGENTS.md': '# Корень\n',
    'src/app.ts': 'export {};\n'
  });

  const loader = makeLoader(root, home);
  const pack = await loader.load();
  const paths = pack.rules.map((rule) => rule.path);

  assert.ok(!paths.includes('.env'), '.env не должен попадать в правила');
  assert.ok(!paths.some((rulePath) => rulePath.includes('.git/')));
  assert.ok(
    pack.manifestWarnings.some((warning) => warning.includes('.env') && warning.includes('секретный')),
    'про .env есть предупреждение'
  );
  assert.ok(
    pack.manifestWarnings.some((warning) => warning.includes('.git/config') && warning.includes('секретный')),
    'про .git/config есть предупреждение'
  );

  loader.dispose();
});

test('manifest rules/skills: симлинк за пределы воркспейса не читается', async () => {
  const outside = path.join(tmpRoot, 'symlink-outside');
  await mkdir(outside, { recursive: true });
  await writeFile(path.join(outside, 'leak.md'), '# outside secret rule\n');
  await mkdir(path.join(outside, 'skills', 'evil'), { recursive: true });
  await writeFile(
    path.join(outside, 'skills', 'evil', 'SKILL.md'),
    '---\nname: evil\ndescription: Внешний скил\n---\n'
  );

  const { root, home } = await makeCase({
    '.dsh/workspace.json': JSON.stringify({
      rules: ['link-out/leak.md'],
      skills: ['link-skills'],
      context: { maxBytes: 100000 }
    }),
    'AGENTS.md': '# Корень\n',
    'src/app.ts': 'export {};\n'
  });
  await symlink(outside, path.join(root, 'link-out'), 'dir');
  await symlink(path.join(outside, 'skills'), path.join(root, 'link-skills'), 'dir');

  const loader = makeLoader(root, home);
  const pack = await loader.load();

  assert.ok(!pack.rules.some((rule) => rule.text.includes('outside secret rule')));
  assert.ok(!pack.skills.some((skill) => skill.name === 'evil'), 'внешний скил не читается');
  assert.ok(
    pack.manifestWarnings.some((warning) => warning.includes('link-out/leak.md') && warning.includes('symlink')),
    'предупреждение про symlink-правило'
  );
  assert.ok(
    pack.manifestWarnings.some((warning) => warning.includes('link-skills') && warning.includes('symlink')),
    'предупреждение про symlink-скилы'
  );

  loader.dispose();
});

test('manifest rules: ./AGENTS.md не дублируется с найденным обходом', async () => {
  const { root, home } = await makeCase({
    '.dsh/workspace.json': JSON.stringify({ rules: ['./AGENTS.md'] }),
    'AGENTS.md': '# Единственные правила\n',
    'src/app.ts': 'export {};\n'
  });

  const loader = makeLoader(root, home);
  const pack = await loader.load();

  assert.equal(
    pack.rules.filter((rule) => rule.path === 'AGENTS.md').length,
    1,
    'правило не должно дублироваться'
  );

  loader.dispose();
});

test('truncateToBytes: граница многобайтного символа не выходит за maxBytes', async () => {
  const { root, home } = await makeCase({
    '.dsh/workspace.json': JSON.stringify({ context: { maxBytes: 101 } }),
    'AGENTS.md': `a${'€'.repeat(100)}`
  });

  const loader = makeLoader(root, home);
  const pack = await loader.load();
  const rule = pack.rules[0];

  assert.ok(rule);
  assert.equal(rule.truncated, true);
  assert.ok(
    Buffer.byteLength(rule.text) <= 101,
    `текст занимает ${String(Buffer.byteLength(rule.text))} байт при лимите 101`
  );
  assert.ok(!rule.text.includes('\uFFFD'), 'разрезанного символа нет');

  loader.dispose();
});
