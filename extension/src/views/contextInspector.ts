/**
 * Модель инспектора контекста (#013): реальные источники правил/скилов,
 * конфликты с объяснением победителя, статистика и проигнорированные пути.
 * Без `vscode` — тесты `tests/context-inspector.test.mjs`.
 */

import type {
  ContextConflict,
  ContextPack,
  RuleDocument,
  SkillDescriptor
} from '../context/contextLoader';

export interface InspectorRule {
  readonly path: string;
  readonly source: 'project' | 'user' | 'builtin';
  readonly depth: number;
  readonly bytes: number;
  readonly truncated: boolean;
}

export interface InspectorSkill {
  readonly name: string;
  readonly path: string;
  readonly source: 'project' | 'user';
  readonly bytes: number;
  readonly description: string;
}

export interface InspectorConflict {
  readonly name: string;
  readonly winner: string;
  readonly ignored: string;
  /** Кто победил и почему (по правилам #006: проект важнее пользователя). */
  readonly explanation: string;
}

export interface InspectorStats {
  readonly files: number;
  readonly bytes: number;
  readonly rules: number;
  readonly skills: number;
  readonly durationMs: number;
  readonly truncated: boolean;
}

export interface ContextInspector {
  readonly workspacePath: string;
  readonly generatedAt: string;
  readonly fingerprint: string;
  readonly stats: InspectorStats;
  readonly rules: readonly InspectorRule[];
  readonly skills: readonly InspectorSkill[];
  readonly conflicts: readonly InspectorConflict[];
  /** Пути, которые не попали в пак из-за конфликтов/усечения. */
  readonly ignoredPaths: readonly string[];
  readonly manifestWarnings: readonly string[];
}

export function buildContextInspector(pack: ContextPack): ContextInspector {
  const rules = pack.rules.map((rule) => toRule(rule));
  const skills = pack.skills.map((skill) => toSkill(skill));
  const conflicts = pack.conflicts.map((conflict) =>
    toConflict(conflict, pack.skills)
  );
  return {
    workspacePath: pack.workspacePath,
    generatedAt: pack.generatedAt,
    fingerprint: pack.fingerprint,
    stats: {
      files: pack.stats.files,
      bytes: pack.stats.bytes,
      rules: rules.length,
      skills: skills.length,
      durationMs: pack.stats.durationMs,
      truncated: pack.stats.truncated
    },
    rules,
    skills,
    conflicts,
    ignoredPaths: [...new Set(conflicts.map((conflict) => conflict.ignored))],
    manifestWarnings: [...pack.manifestWarnings]
  };
}

function toRule(rule: RuleDocument): InspectorRule {
  return {
    path: rule.path,
    source: rule.source,
    depth: rule.depth,
    bytes: rule.bytes,
    truncated: rule.truncated
  };
}

function toSkill(skill: SkillDescriptor): InspectorSkill {
  return {
    name: skill.name,
    path: skill.path,
    source: skill.source,
    bytes: skill.bytes,
    description: skill.description
  };
}

function toConflict(
  conflict: ContextConflict,
  skills: readonly SkillDescriptor[]
): InspectorConflict {
  const winner = skills.find((skill) => skill.path === conflict.winner);
  const ignored = skills.find((skill) => skill.path === conflict.ignored);
  const winnerSource = winner?.source ?? 'project';
  const ignoredSource = ignored?.source ?? 'user';
  return {
    name: conflict.name,
    winner: conflict.winner,
    ignored: conflict.ignored,
    explanation:
      winnerSource === 'project'
        ? `правило проекта ${conflict.winner} победило ${ignoredSource}-скил ${conflict.ignored}: project имеет приоритет (§6)`
        : `скил ${conflict.winner} (${winnerSource}) победил ${conflict.ignored} (${ignoredSource})`
  };
}

/** Короткая сводка для статус-бара/уведомления. */
export function contextSummary(inspector: ContextInspector): string {
  return `контекст: правил ${String(inspector.stats.rules)}, скилов ${String(inspector.stats.skills)}, файлов ${String(inspector.stats.files)}, ${String(inspector.stats.bytes)} байт`;
}
