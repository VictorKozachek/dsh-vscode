/**
 * Рантайм одного воркспейса (#011): мост DSH, сессии, контекст, чат,
 * подтверждения и диффы. Модуль без `vscode` — VS Code-части приходят портами,
 * поэтому сценарии (A→B→A, grace, teardown) проверяются на fake DSH-сервере.
 */

import path from 'node:path';

import {
  AcpRuntime,
  type AcpRuntimeOptions,
  type RuntimeState
} from '../runtime/acpRuntime';
import { ContextLoader } from '../context/contextLoader';
import { ApprovalBroker } from '../approvals/approvalBroker';
import { createNodePathProbe } from '../approvals/pathProbe';
import { evaluateApproval } from '../approvals/approvalPolicy';
import type {
  ApprovalPolicy,
  SandboxMode
} from '../approvals/approvalPolicy';
import { AuditLog } from '../approvals/auditLog';
import { DiffController, type DiffEditorPort } from '../diff/diffController';
import { DiffService, createNodeDiffFileSystem } from '../diff/diffService';
import { ChatController, type ChatSessionsPort } from '../views/chatEvents';
import { SessionManager, type SessionSnapshot } from '../sessions/sessionManager';
import { createRegistrySessionPersistence } from '../sessions/registryPersistence';
import type { ExtensionMessage } from '../views/chatHtml';
import type { WorkspaceRegistry } from './registry';
import type { WorkspaceFolderRef, WorkspaceRuntime } from './lifecycle';

/** Минимум `vscode.Memento` (для тестов — обычный объект). */
export interface MementoPort {
  get<T>(key: string): T | undefined;
  update(key: string, value: unknown): Thenable<void>;
}

/** Опции рантайма воркспейса. */
export interface DshWorkspaceRuntimeOptions {
  readonly folder: WorkspaceFolderRef;
  readonly memento: MementoPort;
  readonly registry: WorkspaceRegistry;
  readonly sandboxMode: string | undefined;
  readonly executablePath: string | undefined;
  readonly profile?: string | undefined;
  readonly homeDirectory?: string | undefined;
  readonly defaultModel?: string | undefined;
  readonly defaultPreset?: string | undefined;
  readonly approvalPolicy: string | undefined;
  readonly workspaceRoot?: string | undefined;
  readonly log: (line: string) => void;
  /** Сообщение в WebView (чат/подтверждения). */
  readonly post: (message: ExtensionMessage) => Promise<void> | void;
  /** Нарисовать diff-редактор (в проде — `VscodeDiffEditor`). */
  readonly createDiffEditor?: (() => DiffEditorPort) | undefined;
  /** Активен ли воркспейс: события чужих воркспейсов отбрасываются. */
  readonly isActive?: (() => boolean) | undefined;
  /** Подмена опций ACP-рантайма — для интеграционных тестов. */
  readonly runtimeOptions?: Partial<AcpRuntimeOptions> | undefined;
  /** Состояние ACP-рантайма (статус-бар/версии #021). */
  readonly onStateChanged?: ((state: RuntimeState) => void) | undefined;
}

/** Рантайм воркспейса с компонентами для UI. */
export class DshWorkspaceRuntime implements WorkspaceRuntime {
  readonly workspaceId: string;
  readonly workspacePath: string;
  readonly #bridge: AcpRuntime;
  readonly #sessions: SessionManager;
  readonly #loader: ContextLoader;
  readonly #chat: ChatController;
  readonly #approvals: ApprovalBroker;
  readonly #diff: DiffController | undefined;
  readonly #log: (line: string) => void;
  readonly #isActive: () => boolean;
  #contextPack: unknown;
  #defaultModel: string | undefined;
  #defaultPreset: string | undefined;
  #approvalCounter = 0;

  constructor(options: DshWorkspaceRuntimeOptions) {
    const { folder } = options;
    this.workspaceId = folder.id;
    this.workspacePath = folder.path;
    this.#log = options.log;
    this.#isActive = options.isActive ?? (() => true);
    this.#defaultModel = options.defaultModel;
    this.#defaultPreset = options.defaultPreset;
    const sandboxMode = parseSandbox(options.sandboxMode);

    const workspaceRoot = options.workspaceRoot ?? folder.path;

    // Подтверждения: ACP permission → ApprovalBroker → инлайн-карточка.
    this.#approvals = new ApprovalBroker({
      context: {
        workspaceRoot,
        sandboxMode,
        policy: parsePolicy(options.approvalPolicy)
      },
      evaluate: evaluateApproval,
      ui: {
        ask: (request) => {
          if (!this.#isActive()) {
            // Событие старого воркспейса: карточку не показываем, отказ.
            return Promise.resolve('deny');
          }
          void options.post({ type: 'approvalRequest', request });
        }
      },
      audit: new AuditLog({ filePath: path.join(workspaceRoot, '.dsh', 'audit.log') }),
      probePath: createNodePathProbe(),
      onResolved: (request, decision) => {
        if (this.#isActive()) {
          void options.post({ type: 'approvalResolved', id: request.id, decision });
        }
      },
      logger: options.log
    });

    this.#bridge = new AcpRuntime({
      workspacePath: folder.path,
      ...(options.executablePath === undefined || options.executablePath === ''
        ? {}
        : { executablePath: options.executablePath }),
      ...(options.profile === undefined ? {} : { profile: options.profile }),
      homeDirectory:
        options.homeDirectory ??
        process.env['HOME'] ??
        process.env['USERPROFILE'] ??
        '',
      logger: (line) => options.log(`[${folder.id}] ${line}`),
      ...options.runtimeOptions,
      ...(options.onStateChanged === undefined
        ? {}
        : { onStateChanged: options.onStateChanged }),
      // Обработчик permission: политика/аудит #009 и ответ ACP.
      permissionHandler: async ({ sessionId, tool, details }) => {
        const optionsList = Array.isArray(details) ? details : [];
        const firstOption = optionsList.find(
          (item) => typeof item === 'object' && item !== null && 'optionId' in item
        ) as { optionId?: unknown } | undefined;
        const decision = await this.#approvals.request({
          id: `acp-${String(this.#approvalCounter++)}`,
          tool,
          kind: inferToolKind(tool),
          sessionId,
          arguments: { details }
        });
        if (decision === 'allow' || decision === 'allow-session') {
          const optionId =
            typeof firstOption?.optionId === 'string' ? firstOption.optionId : 'allow';
          return { optionId };
        }
        return 'cancelled';
      }
    });
    this.#sessions = new SessionManager({
      workspaceId: folder.id,
      bridge: this.#bridge,
      storage: options.memento as never,
      persistence: createRegistrySessionPersistence({
        registry: options.registry,
        workspacePath: folder.path
      }),
      logger: options.log
    });
    this.#loader = new ContextLoader({ root: folder.path, logger: options.log });

    // Чат: события/посты неактивного воркспейса не доходят до UI.
    const gatedBridge = {
      on: (event: string, listener: (payload: unknown) => void) =>
        this.#bridge.on(event as never, (payload: unknown) => {
          if (this.#isActive()) {
            listener(payload);
          }
        }),
      request: (method: string, params: Record<string, unknown>) =>
        this.#bridge.request(method as never, params as never) as Promise<unknown>
    };
    this.#chat = new ChatController({
      bridge: gatedBridge,
      sessions: this.#sessionsPort(),
      getSessionId: () => this.#sessions.state.sessionId,
      post: (message) => {
        if (this.#isActive()) {
          void options.post(message);
        }
      },
      logger: options.log
    });

    if (options.createDiffEditor !== undefined) {
      this.#diff = new DiffController(
        new DiffService({ workspaceRoot, fs: createNodeDiffFileSystem() }),
        options.createDiffEditor()
      );
    } else {
      this.#diff = undefined;
    }
  }

  get chat(): ChatController {
    return this.#chat;
  }

  get sessions(): SessionManager {
    return this.#sessions;
  }

  get approvals(): ApprovalBroker {
    return this.#approvals;
  }

  get diff(): DiffController | undefined {
    return this.#diff;
  }

  /** ACP-рантайм воркспейса (для статус-бара/диагностики #021). */
  get acpRuntime(): AcpRuntime {
    return this.#bridge;
  }

  get contextPack(): unknown {
    return this.#contextPack;
  }

  get processCount(): number {
    return this.#bridge.processId === undefined ? 0 : 1;
  }

  get state(): string {
    return this.#bridge.state;
  }

  async loadContext(): Promise<void> {
    this.#contextPack = await this.#loader.load();
    const stats = (this.#contextPack as { stats?: { durationMs?: number } }).stats;
    this.#log(
      `воркспейс ${this.workspaceId}: контекст загружен (${stats?.durationMs ?? 0} мс)`
    );
  }

  async restoreSession(): Promise<void> {
    await this.#sessions.restore();
  }

  async pause(): Promise<void> {
    await this.#sessions.pause();
  }

  async resume(): Promise<void> {
    await this.#sessions.restore();
  }

  async dispose(): Promise<void> {
    this.#chat.dispose();
    this.#approvals.dispose();
    this.#sessions.dispose();
    this.#loader.dispose();
    await this.#bridge.stop();
  }

  #sessionsPort(): ChatSessionsPort {
    const snapshot = (value: SessionSnapshot) => ({
      sessionId: value.sessionId,
      title: value.title,
      status: value.status,
      ...(this.#defaultModel === undefined ? {} : { model: this.#defaultModel }),
      ...(this.#defaultPreset === undefined ? {} : { preset: this.#defaultPreset })
    });
    return {
      getSnapshot: () => snapshot(this.#sessions.state),
      getDraft: () => this.#sessions.getDraft(),
      setDraft: (text) => this.#sessions.setDraft(text),
      on: (event, listener) =>
        this.#sessions.on(event, (value) => {
          if (this.#isActive()) {
            listener(snapshot(value));
          }
        })
    };
  }
}

function inferToolKind(tool: string): 'read' | 'write' | 'execute' | 'network' {
  const value = tool.toLowerCase();
  if (/read|cat|view|grep|search/.test(value)) {
    return 'read';
  }
  if (/http|fetch|curl|network|web/.test(value)) {
    return 'network';
  }
  if (/run|exec|command|shell|bash/.test(value)) {
    return 'execute';
  }
  return 'write';
}

/** Валидация sandbox: неизвестное значение → `workspace-write`. */
export function parseSandbox(value: string | undefined): SandboxMode {
  return value === 'read-only' || value === 'workspace-write' || value === 'danger-full-access'
    ? value
    : 'workspace-write';
}

/** Валидация политики подтверждений. */
export function parsePolicy(value: string | undefined): ApprovalPolicy {
  return value === 'ask' || value === 'auto' || value === 'never' ? value : 'ask';
}
