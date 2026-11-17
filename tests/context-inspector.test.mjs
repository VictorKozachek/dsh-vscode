import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildContextInspector,
  contextSummary
} from '../extension/src/views/contextInspector.ts';

function pack(overrides = {}) {
  return {
    workspacePath: '/repo',
    manifest: null,
    manifestWarnings: ['manifest: неизвестное поле'],
    rules: [
      { path: 'AGENTS.md', source: 'project', depth: 0, text: 'x', bytes: 100, truncated: false },
      { path: '~/.dsh/AGENTS.md', source: 'user', depth: 0, text: 'y', bytes: 50, truncated: true }
    ],
    skills: [
      { name: 'fmt', description: 'формат', path: '/repo/.dsh/skills/fmt/SKILL.md', source: 'project', bytes: 10 },
      { name: 'fmt', description: 'старый', path: '~/.dsh/skills/fmt/SKILL.md', source: 'user', bytes: 20 }
    ],
    memory: [],
    files: [{ path: 'src/a.ts', bytes: 10, language: 'ts' }],
    conflicts: [
      {
        kind: 'skill',
        name: 'fmt',
        winner: '/repo/.dsh/skills/fmt/SKILL.md',
        ignored: '~/.dsh/skills/fmt/SKILL.md'
      }
    ],
    fingerprint: 'abc',
    generatedAt: '2026-11-17T00:00:00.000Z',
    stats: { files: 1, bytes: 100, byLanguage: {}, durationMs: 12, truncated: false },
    ...overrides
  };
}

test('buildContextInspector: реальные правила, скилы, конфликт с объяснением', () => {
  const inspector = buildContextInspector(pack());
  assert.equal(inspector.rules.length, 2);
  assert.equal(inspector.rules[0].source, 'project');
  assert.equal(inspector.rules[1].truncated, true);
  assert.equal(inspector.skills.length, 2);
  assert.equal(inspector.conflicts.length, 1);
  assert.match(inspector.conflicts[0].explanation, /project/);
  assert.match(inspector.conflicts[0].explanation, /приоритет/);
  assert.deepEqual(inspector.ignoredPaths, ['~/.dsh/skills/fmt/SKILL.md']);
  assert.equal(inspector.stats.rules, 2);
  assert.equal(inspector.manifestWarnings.length, 1);
  assert.match(contextSummary(inspector), /правил 2/);
});

test('buildContextInspector: пустой пак не падает', () => {
  const inspector = buildContextInspector(
    pack({ rules: [], skills: [], conflicts: [], manifestWarnings: [] })
  );
  assert.equal(inspector.rules.length, 0);
  assert.equal(inspector.stats.files, 1);
  assert.deepEqual(inspector.ignoredPaths, []);
});
