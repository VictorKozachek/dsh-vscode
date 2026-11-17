import assert from 'node:assert/strict';
import test from 'node:test';

import {
  checkRemoteRuntime,
  compareVersions,
  remoteKind,
  translateWorkspacePath,
  windowsPathToWsl,
  wslPathToWindows
} from '../extension/src/workspace/remote.ts';

test('remoteKind: ssh/wsl/containers/локальный', () => {
  assert.equal(remoteKind(undefined), 'local');
  assert.equal(remoteKind('  '), 'local');
  assert.equal(remoteKind('ssh'), 'ssh');
  assert.equal(remoteKind('WSL'), 'wsl');
  assert.equal(remoteKind('containers'), 'containers');
  assert.equal(remoteKind('ssh-remote'), 'ssh');
  assert.equal(remoteKind('dev-container'), 'containers');
  assert.equal(remoteKind('attached-container'), 'containers');
  assert.equal(remoteKind('codespaces'), 'codespaces');
});

test('compareVersions: semver-подобное сравнение', () => {
  assert.equal(compareVersions('0.2.0', '0.2.0'), 0);
  assert.equal(compareVersions('0.2.1', '0.2.0'), 1);
  assert.equal(compareVersions('0.1.9', '0.2.0'), -1);
  assert.equal(compareVersions('v0.2.0', '0.2.0'), 0);
  assert.equal(compareVersions('мусор', '0.2.0'), -1);
});

test('checkRemoteRuntime: отсутствие и старая версия дают инструкцию', () => {
  const missing = checkRemoteRuntime({ remoteName: 'ssh', version: undefined });
  assert.equal(missing.kind, 'missing');
  assert.match(missing.instructions, /Установите рантайм/);

  const old = checkRemoteRuntime({ remoteName: 'wsl', version: '0.1.0', required: '0.2.0' });
  assert.equal(old.kind, 'version-mismatch');
  assert.match(old.instructions, /Обновите/);

  const ok = checkRemoteRuntime({ remoteName: 'containers', version: '0.2.2-rc.1' });
  assert.equal(ok.kind, 'ok');
});

test('WSL: трансляция путей Windows ↔ Linux', () => {
  assert.equal(windowsPathToWsl('C:\\repo\\app'), '/mnt/c/repo/app');
  assert.equal(windowsPathToWsl('D:/work'), '/mnt/d/work');
  assert.equal(wslPathToWindows('/mnt/c/repo/app'), 'C:\\repo\\app');
  assert.equal(
    translateWorkspacePath('C:\\repo', { remoteName: 'wsl', platform: 'win32' }),
    '/mnt/c/repo'
  );
  assert.equal(
    translateWorkspacePath('/mnt/d/repo', { remoteName: undefined, platform: 'win32' }),
    'D:\\repo'
  );
  assert.equal(
    translateWorkspacePath('/home/user/repo', { remoteName: 'wsl' }),
    '/home/user/repo'
  );
});
