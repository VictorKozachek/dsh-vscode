import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';

import {
  canonicalizePath,
  normalizeGitRemote,
  normalizePathForKey,
  normalizeRemoteName,
  parseGitConfigRemoteUrl,
  resolveWorkspace,
  workspaceId
} from '../extension/src/workspace/resolver.ts';

// macOS отдаёт /var как симлинк на /private/var — канонизируем сразу,
// иначе realpath внутри резолвера даёт другой путь.
const tmpRoot = await realpath(
  await mkdtemp(path.join(os.tmpdir(), 'dsh-workspace-resolver-'))
);
after(() => rm(tmpRoot, { recursive: true, force: true }));

let caseCounter = 0;

/** Свежий каталог под конкретный тест. */
async function makeCase(name) {
  caseCounter += 1;
  const directory = path.join(tmpRoot, `${String(caseCounter).padStart(2, '0')}-${name}`);
  await mkdir(directory, { recursive: true });
  return directory;
}

/** Папка в форме `vscode.WorkspaceFolder`. */
function folder(fsPath, name = path.basename(fsPath), index = 0) {
  return { uri: { fsPath }, name, index };
}

/** Кладёт `.git/config` с (необязательным) remote. */
async function writeGitConfig(repoDir, { remoteName = 'origin', url = null } = {}) {
  const gitDir = path.join(repoDir, '.git');
  await mkdir(gitDir, { recursive: true });
  const lines = ['[core]', '\trepositoryformatversion = 0', '\tbare = false'];
  if (url !== null) {
    lines.push(`[remote "${remoteName}"]`, `\turl = ${url}`, `\tfetch = +refs/heads/*:refs/remotes/${remoteName}/*`);
  }
  await writeFile(path.join(gitDir, 'config'), `${lines.join('\n')}\n`, 'utf8');
  return gitDir;
}

test('resolveWorkspace: без открытой папки возвращает null', async () => {
  assert.equal(await resolveWorkspace([]), null);
});

test('resolveWorkspace: одиночный корень без git', async () => {
  const root = await makeCase('plain');
  const workspace = await resolveWorkspace([folder(root, 'my-project')]);

  assert.ok(workspace);
  assert.equal(workspace.path, root);
  assert.equal(workspace.name, 'my-project');
  assert.equal(workspace.remote, 'local');
  assert.equal(workspace.gitRemote, null);
  assert.equal(workspace.multiRoot, false);
  assert.deepEqual(workspace.primary, { path: root, name: 'my-project', index: 0 });
  assert.equal(workspace.codeWorkspaceFile, null);
  assert.match(workspace.id, /^[0-9a-f]{16}$/);
});

test('resolveWorkspace: id стабилен при повторных вызовах', async () => {
  const root = await makeCase('stable');
  const first = await resolveWorkspace([folder(root)]);
  const second = await resolveWorkspace([folder(root)]);
  const third = await resolveWorkspace([folder(root, 'другое-имя')]);

  assert.ok(first && second && third);
  assert.equal(first.id, second.id);
  // Имя папки — подсказка для UI, в ключ не входит.
  assert.equal(first.id, third.id);
});

test('resolveWorkspace: remote входит в ключ', async () => {
  const root = await makeCase('remote');
  const local = await resolveWorkspace([folder(root)]);
  const ssh = await resolveWorkspace([folder(root)], { remoteName: 'ssh' });
  const wsl = await resolveWorkspace([folder(root)], { remoteName: 'wsl' });
  const empty = await resolveWorkspace([folder(root)], { remoteName: '  ' });

  assert.ok(local && ssh && wsl && empty);
  assert.equal(ssh.remote, 'ssh');
  assert.notEqual(local.id, ssh.id);
  assert.notEqual(ssh.id, wsl.id);
  assert.equal(empty.remote, 'local');
  assert.equal(empty.id, local.id);
});

test('resolveWorkspace: вложенная папка находит git-remote репозитория', async () => {
  const repo = await makeCase('repo');
  await writeGitConfig(repo, { url: 'git@github.com:acme/api-service.git' });
  const nested = path.join(repo, 'packages', 'core');
  await mkdir(nested, { recursive: true });

  const workspace = await resolveWorkspace([folder(nested, 'core')]);
  assert.ok(workspace);
  assert.equal(workspace.path, nested, 'корень воркспейса — открытая папка, а не корень репозитория');
  assert.equal(workspace.gitRemote, 'github.com/acme/api-service');
});

test('resolveWorkspace: git-репозиторий без remote даёт gitRemote: null', async () => {
  const repo = await makeCase('repo-no-remote');
  await writeGitConfig(repo);

  const workspace = await resolveWorkspace([folder(repo)]);
  assert.ok(workspace);
  assert.equal(workspace.gitRemote, null);
  assert.equal(workspace.id.length, 16);
});

test('resolveWorkspace: симлинк канонизируется к настоящему пути', async () => {
  const target = await makeCase('symlink-target');
  const linkPath = path.join(tmpRoot, 'symlink-link');
  await symlink(target, linkPath, 'dir');

  const viaLink = await resolveWorkspace([folder(linkPath)]);
  const viaTarget = await resolveWorkspace([folder(target)]);

  assert.ok(viaLink && viaTarget);
  assert.equal(viaLink.path, target);
  assert.equal(viaLink.id, viaTarget.id);
});

test('resolveWorkspace: смена регистра пути не меняет id', async (t) => {
  if (process.platform !== 'darwin' && process.platform !== 'win32') {
    t.skip('регистронезависимая файловая система только на macOS/Windows');
    return;
  }
  const root = await makeCase('case');
  const upper = root.toUpperCase();
  const lower = root.toLowerCase();

  const a = await resolveWorkspace([folder(upper)]);
  const b = await resolveWorkspace([folder(lower)]);

  assert.ok(a && b);
  assert.equal(a.id, b.id);
});

test('resolveWorkspace: разные папки одного репозитория дают разные id', async () => {
  const repo = await makeCase('repo-multi');
  await writeGitConfig(repo, { url: 'git@github.com:acme/api-service.git' });
  const frontend = path.join(repo, 'frontend');
  const backend = path.join(repo, 'backend');
  await mkdir(frontend, { recursive: true });
  await mkdir(backend, { recursive: true });

  const front = await resolveWorkspace([folder(frontend, 'frontend')]);
  const back = await resolveWorkspace([folder(backend, 'backend')]);

  assert.ok(front && back);
  assert.equal(front.gitRemote, back.gitRemote, 'gitRemote у папок общий');
  assert.notEqual(front.id, back.id, 'путь входит в ключ: папки — разные воркспейсы');
});

test('workspaceId: путь входит в ключ всегда, gitRemote — дополнительный признак', () => {
  const frontend = workspaceId('local', '/repo/frontend', 'github.com/acme/api-service');
  const backend = workspaceId('local', '/repo/backend', 'github.com/acme/api-service');

  assert.notEqual(frontend, backend, 'две папки одного репозитория не сливаются');
  assert.equal(
    frontend,
    workspaceId('local', '/repo/frontend', 'github.com/acme/api-service'),
    'тот же путь стабилен'
  );
  assert.equal(frontend.length, 16);
  assert.match(frontend, /^[0-9a-f]{16}$/);
});

test('resolveWorkspace: git worktree читает общий конфиг', async () => {
  const repo = await makeCase('worktree-repo');
  await writeGitConfig(repo, { url: 'ssh://git@github.com/acme/api-service.git' });

  const worktree = path.join(repo, 'wt');
  const worktreeGitDir = path.join(repo, '.git', 'worktrees', 'wt');
  await mkdir(worktreeGitDir, { recursive: true });
  await mkdir(worktree, { recursive: true });
  await writeFile(path.join(worktree, '.git'), 'gitdir: ../.git/worktrees/wt\n', 'utf8');
  await writeFile(path.join(worktreeGitDir, 'commondir'), '../..\n', 'utf8');

  const workspace = await resolveWorkspace([folder(worktree)]);
  assert.ok(workspace);
  assert.equal(workspace.gitRemote, 'github.com/acme/api-service');
});

test('resolveWorkspace: multi-root — primary первая папка, .code-workspace определяется', async () => {
  const first = await makeCase('multi-a');
  const second = await makeCase('multi-b');
  const workspaceFile = path.join(tmpRoot, 'project.code-workspace');

  const workspace = await resolveWorkspace([folder(first, 'a', 0), folder(second, 'b', 1)], {
    workspaceFile
  });

  assert.ok(workspace);
  assert.equal(workspace.multiRoot, true);
  assert.equal(workspace.primary.path, first);
  assert.equal(workspace.path, first);
  assert.equal(workspace.folders.length, 2);
  assert.deepEqual(
    workspace.folders.map((item) => item.name),
    ['a', 'b']
  );
  assert.equal(workspace.codeWorkspaceFile, workspaceFile);
});

test('normalizeGitRemote: разбор форм remote-URL', () => {
  const cases = [
    ['git@github.com:acme/api-service.git', 'github.com/acme/api-service'],
    ['git@github.com:acme/api-service', 'github.com/acme/api-service'],
    ['ssh://git@github.com:22/acme/api-service.git', 'github.com/acme/api-service'],
    ['https://github.com/acme/api-service.git', 'github.com/acme/api-service'],
    ['https://user:token@gitlab.example.com/group/sub/repo.git', 'gitlab.example.com/group/sub/repo'],
    ['git://git.example.com/repo.git/', 'git.example.com/repo'],
    ['/srv/git/repo.git', null],
    ['file:///srv/git/repo.git', null],
    ['C:\\repos\\api', null],
    ['', null]
  ];

  for (const [url, expected] of cases) {
    assert.equal(normalizeGitRemote(url), expected, url);
  }
});

test('parseGitConfigRemoteUrl: origin приоритетнее, кавычки и комментарии', () => {
  const config = [
    '# комментарий',
    '[core]',
    '\trepositoryformatversion = 0',
    '[remote "upstream"]',
    '\turl = https://github.com/upstream/repo.git',
    '[remote "origin"]',
    '\turl = "git@github.com:acme/api-service.git"',
    '\tfetch = +refs/heads/*:refs/remotes/origin/*'
  ].join('\n');

  assert.equal(parseGitConfigRemoteUrl(config), 'git@github.com:acme/api-service.git');
  assert.equal(parseGitConfigRemoteUrl('[core]\n\tbare = false\n'), null);
  assert.equal(
    parseGitConfigRemoteUrl('[remote "upstream"]\n\turl = https://example.com/x.git\n'),
    'https://example.com/x.git'
  );
});

test('normalizePathForKey: регистр и NFC в ключе', () => {
  assert.equal(normalizePathForKey('/Users/Victor/Projects/API', 'darwin'), '/users/victor/projects/api');
  assert.equal(normalizePathForKey('/Users/Victor/Projects/API', 'linux'), '/Users/Victor/Projects/API');
  assert.equal(normalizePathForKey('C:\\Users\\Victor\\API', 'win32'), 'c:/users/victor/api');

  const decomposed = '/tmp/project-e\u0301';
  const composed = '/tmp/project-\u00e9';
  assert.equal(normalizePathForKey(decomposed, 'linux'), normalizePathForKey(composed, 'linux'));
});

test('canonicalizePath: путь нормализован к NFC', async () => {
  const composed = '\u00e9';
  const directory = path.join(tmpRoot, `nfc-${composed}`);
  await mkdir(directory, { recursive: true });

  const resolved = await canonicalizePath(directory);
  assert.equal(resolved, resolved.normalize('NFC'));
});

test('normalizeRemoteName: пустой remoteName — локальный воркспейс', () => {
  assert.equal(normalizeRemoteName(undefined), 'local');
  assert.equal(normalizeRemoteName(''), 'local');
  assert.equal(normalizeRemoteName(' SSH '), 'ssh');
  assert.equal(normalizeRemoteName('dev-container'), 'dev-container');
});

test('горячий путь: резолвер не запускает процессы', async () => {
  const source = await readFile(
    path.join(import.meta.dirname, '..', 'extension', 'src', 'workspace', 'resolver.ts'),
    'utf8'
  );

  assert.doesNotMatch(source, /from\s+['"](?:node:)?child_process['"]/);
  assert.doesNotMatch(source, /require\(\s*['"](?:node:)?child_process['"]\s*\)/);
  assert.doesNotMatch(source, /(?<![.\w])(?:spawn|execFile|execSync|fork)\s*\(/);
});
