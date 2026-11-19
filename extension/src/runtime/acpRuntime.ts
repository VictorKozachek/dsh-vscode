/**
 * DshRuntime — запуск настоящего DSH-рантайма (#021).
 *
 * Маршрут (ADR `docs/adr/0001-dsh-runtime.md`): `dsh --profile acp` — штатный
 * automation-only ACP-сервер по stdio NDJSON. Публичный API `DshBridge`
 * сохраняется: `AcpRuntime` реализует тот же порт (`start/stop/request/on`) для
 * `SessionManager` (#007), меняется только транспорт.
 *
 * Что делает супервизор:
 * - ищет бинарь (`dsh.executablePath` → PATH → профиль → npx) и инструкцию,
 *   если рантайма нет (extension host при этом жив, состояние `failed`);
 * - поднимает процесс с cwd воркспейса, делает `initialize`, знает версии;
 * - перезапускает упавший процесс с экспоненциальным backoff;
 * - гасит SIGTERM → SIGKILL, дерево процессов не остаётся;
 * - не пишет токены/креденшелы в лог (`redactSecrets`).
 *
 * Тесты: `tests/acp-runtime.test.mjs` (фейковый ACP-процесс),
 * `tests/dsh-runtime-e2e.test.mjs` (опционально, реальный рантайм).
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { readFile, realpath } from 'node:fs/promises';
import path from 'node:path';

import type {
  DshEvent,
  DshEventPayload,
  DshMethod,
  DshMethodParams,
  DshMethodResult
} from '@dsh-vscode/protocol';

import type { DshBridgePort } from '../sessions/sessionManager';

import { AcpPeer, AcpError } from './acpPeer';
import {
  mapAcpNotification,
  mapCreateResult,
  mapListResult,
  mapPromptOutcome,
  mapResumeResult,
  toAcpCall,
  type AcpSessionSummary
} from './acpProtocol';
import {
  discoverRuntime,
  redactSecrets,
  type RuntimeDiscoveryResult,
  type RuntimeLaunchCommand
} from './discovery';

/** Состояние супервизора. */
export type RuntimeState = 'stopped' | 'starting' | 'running' | 'restarting' | 'failed';

/** Версии рантайма для статуса. */
export interface RuntimeVersionInfo {
  readonly dsh?: string | undefined;
  readonly acp?: string | undefined;
}

/** Диагностика для статус-бара/экрана ошибки. */
export interface RuntimeDiagnostics {
  readonly state: RuntimeState;
  readonly message: string;
  readonly instructions?: string | undefined;
  readonly displayPath?: string | undefined;
  readonly version?: RuntimeVersionInfo | undefined;
}

/** Настройки рантайма. */
/** Handle ACP terminal client: вывод по мере выполнения + kill/release. */
export interface TerminalClientHandle {
  readonly status: string;
  output(): { readonly text: string; readonly truncated: boolean };
  waitForExit(): Promise<number | undefined>;
  kill(): void;
  release(): void;
  readonly error?: string | undefined;
}

export interface AcpRuntimeOptions {
  /** cwd воркспейса и `cwd` для ACP-сессий. */
  readonly workspacePath: string;
  readonly executablePath?: string | undefined;
  /** `dsh.profile`, по умолчанию `acp`. */
  readonly profile?: string | undefined;
  /** Домашний каталог для поиска профиля (`~`). */
  readonly homeDirectory: string;
  readonly env?: NodeJS.ProcessEnv | undefined;
  /** Для тестов/extension host: подмена process.execPath и Electron-режима. */
  readonly processExecPath?: string | undefined;
  readonly electronRuntime?: boolean | undefined;
  readonly logger?: ((line: string) => void) | undefined;
  readonly onStateChanged?: ((state: RuntimeState) => void) | undefined;
  /** Таймаут обычных запросов (initialize, session.*). */
  readonly requestTimeoutMs?: number | undefined;
  /** Таймаут одного хода (prompt). */
  readonly turnTimeoutMs?: number | undefined;
  /** Сколько ждать SIGTERM до SIGKILL. */
  readonly shutdownGraceMs?: number | undefined;
  readonly restartInitialDelayMs?: number | undefined;
  readonly restartDelayFactor?: number | undefined;
  readonly restartMaxDelayMs?: number | undefined;
  readonly maxRestartAttempts?: number | undefined;
  /** Сколько рантайм должен прожить, чтобы счётчик рестартов сбросился. */
  readonly restartStableMs?: number | undefined;
  /** Подмена поиска (тесты). */
  readonly discovery?: Pick<
    NonNullable<Parameters<typeof discoverRuntime>[0]>,
    'isFile' | 'which' | 'allowNpxFallback'
  > | undefined;
  readonly now?: (() => Date) | undefined;
  /**
   * Ответ на ACP `session/request_permission`. По умолчанию — `cancelled`
   * (безопасный отказ); #011 сможет подключить сюда ApprovalBroker.
   */
  /**
   * ACP terminal client (`terminal/create`): выполняет команду и отдаёт
   * вывод/код возврата. Реальный ACP-агент использует именно эти методы.
   */
  readonly terminalClient?:
    | ((input: {
        readonly sessionId: string;
        readonly command: string;
        readonly cwd: string | undefined;
        readonly env?: Readonly<Record<string, string>> | undefined;
        readonly maxOutputBytes?: number | undefined;
      }) => Promise<TerminalClientHandle>)
    | undefined;
  readonly permissionHandler?:
    | ((request: {
        readonly sessionId: string;
        readonly tool: string;
        readonly details: Record<string, unknown>;
      }) => Promise<'cancelled' | { readonly optionId: string }>)
    | undefined;
}

const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const DEFAULT_TURN_TIMEOUT_MS = 30 * 60_000;
const DEFAULT_SHUTDOWN_GRACE_MS = 3_000;
const DEFAULT_RESTART_INITIAL_MS = 500;
const DEFAULT_RESTART_FACTOR = 2;
const DEFAULT_RESTART_MAX_MS = 10_000;
const DEFAULT_MAX_RESTART_ATTEMPTS = 5;
const DEFAULT_RESTART_STABLE_MS = 30_000;

/** PATH для spawn: каталог текущего Node в начале, остальной PATH сохранён. */
export function buildSpawnEnvironment(
  baseEnv: NodeJS.ProcessEnv,
  execPath: string = process.execPath,
  electron: boolean = process.versions['electron'] !== undefined
): NodeJS.ProcessEnv {
  // В extension host VS Code process.execPath — Electron/Code Helper, node в
  // его каталоге нет; добавлять этот каталог в PATH бессмысленно (#031 review).
  if (electron) {
    return { ...baseEnv };
  }
  const nodeDirectory = path.dirname(execPath);
  const separator = process.platform === 'win32' ? ';' : ':';
  const existing = baseEnv['PATH'] ?? '';
  const parts = existing.split(separator).filter((part) => part !== '');
  if (!parts.includes(nodeDirectory)) {
    parts.unshift(nodeDirectory);
  }
  return { ...baseEnv, PATH: parts.join(separator) };
}

/** План spawn с учётом Electron: ELECTRON_RUN_AS_NODE=1 + process.execPath. */
export interface SpawnPlan {
  readonly executable: string;
  readonly args: readonly string[];
  readonly env: NodeJS.ProcessEnv;
  readonly fallback: boolean;
}

export function buildSpawnPlan(options: {
  readonly command: string;
  readonly args: readonly string[];
  readonly baseEnv: NodeJS.ProcessEnv;
  readonly execPath?: string | undefined;
  readonly electron?: boolean | undefined;
  readonly isScript?: boolean | undefined;
  readonly envNode?: boolean | undefined;
}): SpawnPlan {
  const execPath = options.execPath ?? process.execPath;
  const electron = options.electron ?? process.versions['electron'] !== undefined;
  const env = buildSpawnEnvironment(options.baseEnv, execPath, electron);
  const nodeOnPath = hasNodeOnPath(options.baseEnv);
  const fallback = options.envNode === true && !nodeOnPath;
  const useNode = options.isScript === true || fallback;
  if (!useNode) {
    return { executable: options.command, args: options.args, env, fallback: false };
  }
  if (electron) {
    env['ELECTRON_RUN_AS_NODE'] = '1';
  }
  return {
    executable: execPath,
    args: [options.command, ...options.args],
    env,
    fallback
  };
}

/** Скрипт с shebang `#!/usr/bin/env node`. */
export async function isEnvNodeScript(command: string): Promise<boolean> {
  if (command === 'npx' || command === 'node') {
    return false;
  }
  try {
    const content = await readFile(command, 'utf8');
    const firstLine = content.split('\n', 1)[0] ?? '';
    return firstLine.startsWith('#!') && /\benv\s+node\b/.test(firstLine);
  } catch {
    return false;
  }
}

function hasNodeOnPath(baseEnv: NodeJS.ProcessEnv): boolean {
  const separator = process.platform === 'win32' ? ';' : ':';
  return (baseEnv['PATH'] ?? '')
    .split(separator)
    .some((directory) => directory !== '' && /node(\.exe)?$/i.test(directory));
}

/**
 * Рантайм DSH поверх ACP stdio. Реализует порт `DshBridgePort` (#004/#007).
 */
export class AcpRuntime {
  readonly #options: AcpRuntimeOptions;
  readonly #workspacePath: string;
  readonly #logLine: (line: string) => void;
  readonly #listeners = new Map<DshEvent, Set<(payload: unknown) => void>>();

  #state: RuntimeState = 'stopped';
  #child: ChildProcess | undefined;
  #peer: AcpPeer | undefined;
  #command: RuntimeLaunchCommand | undefined;
  #instructions: string | undefined;
  #lastError: string | undefined;
  #agentInfo: { name?: string; version?: string } | undefined;
  #dshVersion: string | undefined;
  #attempts = 0;
  #startedAt = 0;
  #stopping = false;
  #restartTimer: NodeJS.Timeout | undefined;
  #turnCounter = 0;
  #disposed = false;
  /** Активный ход на сессию: ACP не присылает turnId в session/update. */
  #activeTurns = new Map<string, string>();
  #terminals = new Map<string, TerminalClientHandle>();
  #terminalCounter = 0;
  /** Поколение запуска: stop() инвалидирует незавершённый discovery. */
  #startToken = 0;

  constructor(options: AcpRuntimeOptions) {
    this.#options = options;
    this.#workspacePath = path.resolve(options.workspacePath);
    const logger = options.logger ?? (() => undefined);
    this.#logLine = (line) => {
      logger(redactSecrets(line));
    };
  }

  get state(): RuntimeState {
    return this.#state;
  }

  /** PID процесса (для диагностики и тестов; `undefined` — не запущен). */
  get processId(): number | undefined {
    return this.#child?.pid;
  }

  /** Версия для статуса. */
  get version(): RuntimeVersionInfo {
    return {
      ...(this.#dshVersion === undefined ? {} : { dsh: this.#dshVersion }),
      ...(this.#agentInfo?.version === undefined ? {} : { acp: this.#agentInfo.version })
    };
  }

  /** Диагностика: состояние, инструкция «не найден», путь, версии. */
  get diagnostics(): RuntimeDiagnostics {
    return {
      state: this.#state,
      message: this.#message(),
      ...(this.#instructions === undefined ? {} : { instructions: this.#instructions }),
      ...(this.#command === undefined ? {} : { displayPath: this.#command.displayPath }),
      version: this.version
    };
  }

  /** Запуск: поиск бинаря, spawn, `initialize`. Не бросает при «не найден». */
  async start(): Promise<void> {
    if (this.#disposed) {
      throw new AcpError('рантайм уже закрыт');
    }
    if (this.#state === 'running' || this.#state === 'starting') {
      return;
    }
    this.#stopping = false;
    this.#attempts = 0;
    this.#instructions = undefined;
    this.#lastError = undefined;
    const token = ++this.#startToken;

    const discovery = await this.#discover();
    // stop()/dispose() могли прийти, пока шёл поиск бинаря.
    if (token !== this.#startToken || this.#stopping || this.#disposed) {
      this.#setState('stopped');
      return;
    }
    if (discovery.status === 'missing' || discovery.command === undefined) {
      this.#instructions = discovery.instructions;
      this.#lastError = discovery.instructions.split('\n')[0] ?? 'DSH runtime не найден';
      this.#setState('failed');
      this.#log(`ACP: ${this.#lastError}`);
      for (const attempt of discovery.attempts) {
        this.#log(`ACP: попытка — ${attempt}`);
      }
      return;
    }

    await this.#spawnWith(discovery.command);
  }

  /** Остановка: SIGTERM → SIGKILL, отмена рестартов. */
  async stop(): Promise<void> {
    this.#stopping = true;
    this.#startToken += 1;
    if (this.#restartTimer !== undefined) {
      clearTimeout(this.#restartTimer);
      this.#restartTimer = undefined;
    }
    const child = this.#child;
    this.#child = undefined;
    this.#peer?.dispose(new AcpError('ACP-рантайм остановлен'));
    this.#peer = undefined;

    if (child === undefined) {
      // Диагностика «рантайм не найден» не должна пропадать после stop().
      if (this.#state !== 'failed') {
        this.#setState('stopped');
      }
      this.#stopping = false;
      return;
    }

    const killTree = (signal: NodeJS.Signals): void => {
      this.#killTree(child, signal);
    };

    await new Promise<void>((resolve) => {
      let settled = false;
      const done = (): void => {
        if (!settled) {
          settled = true;
          clearTimeout(killTimer);
          resolve();
        }
      };
      child.once('exit', done);
      if (!child.killed) {
        killTree('SIGTERM');
      }
      const killTimer = setTimeout(() => {
        killTree('SIGKILL');
        done();
      }, this.#options.shutdownGraceMs ?? DEFAULT_SHUTDOWN_GRACE_MS);
    });

    this.#activeTurns.clear();
    if (this.#state !== 'failed') {
      this.#setState('stopped');
    }
    this.#stopping = false;
  }

  /** Закрытие (extension deactivate). */
  async dispose(): Promise<void> {
    this.#disposed = true;
    await this.stop();
    this.#listeners.clear();
  }

  /** Запрос нашего API; для `turn.start` возвращает turnId сразу. */
  async request<M extends DshMethod>(
    method: M,
    params: DshMethodParams<M>,
    options: { timeoutMs?: number | undefined; signal?: AbortSignal | undefined } = {}
  ): Promise<DshMethodResult<M>> {
    if (this.#state !== 'running' || this.#peer === undefined) {
      throw new AcpError(`DSH-рантайм не готов: ${this.#message()}`);
    }
    const record = params as unknown as Record<string, unknown>;

    if (method === 'workspace.ping') {
      return {
        pong: true,
        ...(this.#agentInfo?.version === undefined
          ? {}
          : { protocolVersion: this.#agentInfo.version })
      } as unknown as DshMethodResult<M>;
    }

    if (method === 'turn.start') {
      return this.#startTurn(record) as unknown as DshMethodResult<M>;
    }

    if (method === 'turn.cancel') {
      this.#peer.notify('session/cancel', { sessionId: String(record['sessionId'] ?? '') });
      return { cancelled: true } as unknown as DshMethodResult<M>;
    }

    const call = toAcpCall(method, record, this.#workspacePath);
    if (call === null) {
      throw new AcpError(`DSH-рантайм не поддерживает метод ${method}`);
    }
    let result: unknown;
    try {
      result = await this.#peer.request(call.method, call.params, {
        timeoutMs: options.timeoutMs ?? this.#options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS
      });
    } catch (error) {
      // ACP не даёт resume уже активной в этом процессе сессии — для нас это
      // успех: сессия и так доступна.
      if (
        method === 'session.resume' &&
        error instanceof Error &&
        /already active/i.test(error.message)
      ) {
        this.#log('ACP: сессия уже активна — resume считается успешным');
        return mapResumeResult(
          {},
          String(record['sessionId'] ?? ''),
          this.#workspacePath,
          (this.#options.now ?? (() => new Date()))().toISOString()
        ) as unknown as DshMethodResult<M>;
      }
      throw error;
    }
    const now = (this.#options.now ?? (() => new Date()))().toISOString();

    switch (method) {
      case 'session.list':
        return mapListResult(result, record['workspaceId'] as string | undefined, this.#workspacePath, now) as unknown as DshMethodResult<M>;
      case 'session.create':
        return mapCreateResult(result, now) as unknown as DshMethodResult<M>;
      case 'session.resume':
        return mapResumeResult(
          result,
          String(record['sessionId'] ?? ''),
          this.#workspacePath,
          now
        ) as unknown as DshMethodResult<M>;
      default:
        throw new AcpError(`DSH-рантайм не поддерживает метод ${method}`);
    }
  }

  /** Подписка на событие в формате нашего протокола. */
  on<E extends DshEvent>(
    event: E,
    listener: (payload: DshEventPayload<E>) => void
  ): { dispose(): void } {
    const set = this.#listeners.get(event) ?? new Set();
    set.add(listener as (payload: unknown) => void);
    this.#listeners.set(event, set);
    return {
      dispose: () => {
        set.delete(listener as (payload: unknown) => void);
      }
    };
  }

  // --- внутреннее ----------------------------------------------------------

  #startTurn(record: Record<string, unknown>): { turnId: string; sessionId: string } {
    const sessionId = String(record['sessionId'] ?? '');
    this.#turnCounter += 1;
    const turnId = `turn-${String(this.#turnCounter)}`;
    this.#activeTurns.set(sessionId, turnId);
    const peer = this.#peer;
    if (peer === undefined) {
      throw new AcpError('DSH-рантайм не готов');
    }

    const call = toAcpCall('turn.start', record, this.#workspacePath);
    if (call === null) {
      throw new AcpError('ACP не принимает turn.start');
    }

    void peer
      .request(call.method, call.params, {
        timeoutMs: this.#options.turnTimeoutMs ?? DEFAULT_TURN_TIMEOUT_MS
      })
      .then(
        (result) => {
          if (this.#stopping) {
            return;
          }
          this.#activeTurns.delete(sessionId);
          const outcome = mapPromptOutcome(sessionId, turnId, result);
          this.#emit('turn.done', outcome.payload);
        },
        (error: unknown) => {
          if (this.#stopping) {
            return;
          }
          this.#activeTurns.delete(sessionId);
          const message = error instanceof Error ? error.message : String(error);
          this.#log(`ACP: ход ${turnId} завершился ошибкой: ${message}`);
          this.#emit('error', { message, sessionId });
          this.#emit('turn.done', { sessionId, turnId, finishReason: 'error' });
        }
      );

    return { turnId, sessionId };
  }

  async #discover(): Promise<RuntimeDiscoveryResult> {
    return discoverRuntime({
      executablePath: this.#options.executablePath,
      profile: this.#options.profile,
      homeDirectory: this.#options.homeDirectory,
      ...(this.#options.discovery ?? {})
    });
  }

  async #spawnWith(command: RuntimeLaunchCommand): Promise<void> {
    this.#command = command;
    this.#setState('starting');
    this.#log(`ACP: запуск ${command.displayPath} (${command.source})`);

    const isScript = command.command === 'npx' ? false : /\.[cm]?js$/i.test(command.command);
    const baseEnv = this.#options.env ?? process.env;
    const execPath = this.#options.processExecPath ?? process.execPath;
    const electron = this.#options.electronRuntime ?? process.versions['electron'] !== undefined;
    const envNode = isScript ? false : await isEnvNodeScript(command.command);
    const plan = buildSpawnPlan({
      command: command.command,
      args: command.args,
      baseEnv,
      execPath,
      electron,
      isScript,
      envNode
    });
    this.#log(
      `ACP: node ${execPath} (${electron ? 'Electron, ELECTRON_RUN_AS_NODE=1' : 'node'}); PATH ${plan.env['PATH'] ?? ''}${plan.fallback ? ' (fallback env node → process.execPath)' : ''}`
    );

    let child: ChildProcess;
    try {
      child = spawn(plan.executable, [...plan.args], {
        cwd: this.#workspacePath,
        env: plan.env,
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
        // На POSIX — своя группа процессов: stop() гасит и внуков (npx и т.п.).
        detached: process.platform !== 'win32'
      });
    } catch (error) {
      this.#fail(`не удалось запустить ${command.displayPath}: ${describeError(error)}`);
      return;
    }
    this.#child = child;

    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (chunk: string) => {
      for (const line of chunk.split('\n')) {
        if (line.trim() !== '') {
          this.#log(`ACP stderr: ${line.trim()}`);
        }
      }
    });
    child.on('error', (error) => {
      this.#fail(`ошибка процесса DSH: ${error.message}`);
    });
    child.on('exit', (code, signal) => {
      this.#handleExit(code, signal);
    });

    const peer = new AcpPeer({
      input: child.stdout ?? process.stdin,
      output: child.stdin ?? process.stdout,
      requestTimeoutMs: this.#options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
      log: (line) => {
        this.#log(`ACP: ${line}`);
      },
      onNotification: (method, params) => {
        this.#handleNotification(method, params);
      },
      onRequest: (method, params) => this.#handleServerRequest(method, params)
    });
    this.#peer = peer;

    try {
      const initialized = await peer.request(
        'initialize',
        {
          protocolVersion: 1,
          clientCapabilities: { terminal: true, fs: { readTextFile: false, writeTextFile: false } }
        },
        { timeoutMs: this.#options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS }
      );
      const info = (initialized as { agentInfo?: { name?: string; version?: string } }).agentInfo;
      this.#agentInfo = info === undefined ? undefined : { ...info };
      this.#dshVersion = await detectDshVersion(command.command);
      // #attempts НЕ сбрасываем здесь: иначе crash loop после initialize
      // никогда не достигает лимита. Сброс — после стабильного аптайма.
      this.#startedAt = Date.now();
      this.#instructions = undefined;
      this.#lastError = undefined;
      this.#setState('running');
      this.#log(
        `ACP: рантайм готов (dsh ${this.#dshVersion ?? 'version?'}, acp ${info?.version ?? '?'})`
      );
    } catch (error) {
      if (this.#stopping || this.#disposed) {
        // Остановка во время initialize — это не failed.
        this.#peer?.dispose(new AcpError('ACP-рантайм остановлен'));
        this.#peer = undefined;
        const current = this.#child;
        this.#child = undefined;
        if (current !== undefined) {
          this.#killTree(current, 'SIGKILL');
        }
        this.#setState('stopped');
        return;
      }
      this.#fail(`initialize не удался: ${describeError(error)}`);
    }
  }

  #handleExit(code: number | null, signal: NodeJS.Signals | null): void {
    if (code === 127) {
      this.#log(
        'ACP: код 127 — dsh не смог найти node (env node). Проверьте PATH или укажите путь к node/dsh в dsh.executablePath.'
      );
    }
    const wasStopping = this.#stopping;
    const uptime = this.#startedAt === 0 ? 0 : Date.now() - this.#startedAt;
    this.#startedAt = 0;
    this.#peer?.dispose(new AcpError(`ACP-процесс завершился (${String(code ?? signal)})`));
    this.#peer = undefined;
    this.#child = undefined;

    if (wasStopping) {
      return;
    }
    if (this.#state === 'failed') {
      return;
    }
    const stableMs = this.#options.restartStableMs ?? DEFAULT_RESTART_STABLE_MS;
    if (uptime >= stableMs) {
      // Долго работал — считаем прошлые падения историей.
      this.#attempts = 0;
    }
    const maxAttempts = this.#options.maxRestartAttempts ?? DEFAULT_MAX_RESTART_ATTEMPTS;
    if (this.#attempts >= maxAttempts) {
      this.#fail(
        `DSH-рантайм аварийно завершился (${String(code ?? signal)}), попытки перезапуска исчерпаны`
      );
      return;
    }

    this.#attempts += 1;
    const initial = this.#options.restartInitialDelayMs ?? DEFAULT_RESTART_INITIAL_MS;
    const factor = this.#options.restartDelayFactor ?? DEFAULT_RESTART_FACTOR;
    const maxDelay = this.#options.restartMaxDelayMs ?? DEFAULT_RESTART_MAX_MS;
    const delay = Math.min(initial * factor ** (this.#attempts - 1), maxDelay);
    this.#setState('restarting');
    this.#log(
      `ACP: процесс завершился (${String(code ?? signal)}), перезапуск через ${String(delay)} мс (попытка ${String(this.#attempts)}/${String(maxAttempts)})`
    );
    this.#restartTimer = setTimeout(() => {
      this.#restartTimer = undefined;
      if (this.#stopping || this.#state === 'failed') {
        return;
      }
      if (this.#command === undefined) {
        this.#fail('команда запуска потеряна');
        return;
      }
      void this.#spawnWith(this.#command);
    }, delay);
  }

  async #handleServerRequest(method: string, params: unknown): Promise<unknown> {
    if (method.startsWith('terminal/')) {
      return this.#handleTerminalRequest(method, (params ?? {}) as Record<string, unknown>);
    }
    if (method !== 'session/request_permission') {
      throw new AcpError(`клиент не поддерживает метод ${method}`);
    }
    const record = (params ?? {}) as Record<string, unknown>;
    const sessionId = typeof record['sessionId'] === 'string' ? record['sessionId'] : '';
    const toolCall = (record['toolCall'] ?? {}) as Record<string, unknown>;
    const tool =
      typeof toolCall['title'] === 'string'
        ? toolCall['title']
        : typeof toolCall['toolCallId'] === 'string'
          ? toolCall['toolCallId']
          : 'tool';
    const details = (record['options'] ?? {}) as Record<string, unknown>;
    this.#emit('approval.request', {
      sessionId,
      approvalId: typeof toolCall['toolCallId'] === 'string' ? toolCall['toolCallId'] : 'permission',
      tool,
      details
    });
    if (this.#options.permissionHandler === undefined) {
      return { outcome: { outcome: 'cancelled' } };
    }
    const decision = await this.#options.permissionHandler({ sessionId, tool, details });
    return decision === 'cancelled'
      ? { outcome: { outcome: 'cancelled' } }
      : { outcome: { outcome: 'selected', optionId: decision.optionId } };
  }

  async #handleTerminalRequest(
    method: string,
    params: Record<string, unknown>
  ): Promise<unknown> {
    const terminalId = typeof params['terminalId'] === 'string' ? params['terminalId'] : '';
    if (method === 'terminal/create') {
      const client = this.#options.terminalClient;
      if (client === undefined) {
        throw new AcpError('терминал не подключён');
      }
      const command = typeof params['command'] === 'string' ? params['command'] : '';
      const args = Array.isArray(params['args'])
        ? params['args'].filter((item): item is string => typeof item === 'string')
        : [];
      const full = [command, ...args].join(' ').trim();
      const sessionId = typeof params['sessionId'] === 'string' ? params['sessionId'] : '';
      const cwd = typeof params['cwd'] === 'string' ? params['cwd'] : undefined;
      const env =
        typeof params['env'] === 'object' && params['env'] !== null
          ? (params['env'] as Record<string, string>)
          : undefined;
      const limit =
        typeof params['outputByteLimit'] === 'number' ? params['outputByteLimit'] : undefined;
      const handle = await client({
        sessionId,
        command: full,
        cwd,
        ...(env === undefined ? {} : { env }),
        ...(limit === undefined ? {} : { maxOutputBytes: limit })
      });
      this.#terminalCounter += 1;
      const id = `term-${String(this.#terminalCounter)}`;
      this.#terminals.set(id, handle);
      return { terminalId: id };
    }
    const terminal = this.#terminals.get(terminalId);
    if (terminal === undefined) {
      throw new AcpError(`терминал ${terminalId} не найден`);
    }
    switch (method) {
      case 'terminal/output': {
        const output = terminal.output();
        return {
          output: output.text,
          truncated: output.truncated,
          ...(terminal.error === undefined ? {} : { error: terminal.error })
        };
      }
      case 'terminal/wait_for_exit':
        return { exitCode: await terminal.waitForExit() };
      case 'terminal/kill':
        terminal.kill();
        return {};
      case 'terminal/release':
        terminal.release();
        this.#terminals.delete(terminalId);
        return {};
      default:
        throw new AcpError(`клиент не поддерживает метод ${method}`);
    }
  }

  #handleNotification(method: string, params: unknown): void {
    const mapped = mapAcpNotification(method, params);
    if (mapped !== null && mapped.event === 'token') {
      const sessionId = typeof mapped.payload['sessionId'] === 'string' ? mapped.payload['sessionId'] : '';
      const activeTurn = this.#activeTurns.get(sessionId);
      if (activeTurn !== undefined) {
        // ACP session/update не несёт turnId — подставляем активный ход,
        // иначе ChatController отбросит токены как «чужой ход».
        mapped.payload['turnId'] = activeTurn;
      }
    }
    if (mapped === null) {
      if (method !== 'session/update') {
        this.#log(`ACP: уведомление ${method} не поддержано`);
      }
      return;
    }
    this.#emit(mapped.event, mapped.payload);
  }

  #emit(event: DshEvent, payload: unknown): void {
    for (const listener of this.#listeners.get(event) ?? []) {
      try {
        listener(payload);
      } catch (error) {
        this.#log(`ACP: слушатель ${event} упал: ${describeError(error)}`);
      }
    }
  }

  #fail(message: string): void {
    this.#lastError = message;
    this.#setState('failed');
    this.#log(`ACP: ${message}`);
    const child = this.#child;
    this.#child = undefined;
    this.#peer?.dispose(new AcpError(message));
    this.#peer = undefined;
    if (child !== undefined) {
      // Гасим всю группу: при неудачном initialize npx-обёртка не должна
      // оставить dsh-внука сиротой.
      this.#killTree(child, 'SIGKILL');
    }
  }

  /** SIGTERM/SIGKILL всей группе (POSIX), fallback — direct child. */
  #killTree(child: ChildProcess, signal: NodeJS.Signals): void {
    try {
      if (process.platform !== 'win32' && child.pid !== undefined) {
        process.kill(-child.pid, signal);
        return;
      }
    } catch {
      // группы нет — гасим direct child
    }
    try {
      child.kill(signal);
    } catch {
      // уже мёртв
    }
  }

  #setState(state: RuntimeState): void {
    if (this.#state === state) {
      return;
    }
    this.#state = state;
    try {
      this.#options.onStateChanged?.(state);
    } catch {
      // статус-бар не должен ломать супервизор
    }
  }

  #message(): string {
    switch (this.#state) {
      case 'running':
        return `DSH ${this.#dshVersion ?? ''} готов (ACP ${this.#agentInfo?.version ?? '?'})`.trim();
      case 'starting':
        return 'запуск DSH-рантайма…';
      case 'restarting':
        return `перезапуск DSH (попытка ${String(this.#attempts)})`;
      case 'failed':
        return this.#lastError ?? 'DSH-рантайм недоступен';
      default:
        return 'DSH-рантайм остановлен';
    }
  }

  #log(line: string): void {
    this.#logLine(line);
  }
}

/** Версия пакета `@deepseek-ai/dsh` рядом с исполняемым файлом (best-effort). */
async function detectDshVersion(command: string): Promise<string | undefined> {
  if (command === 'npx') {
    return undefined;
  }
  try {
    let directory = path.dirname(await realpath(command));
    for (let depth = 0; depth < 8; depth += 1) {
      try {
        const raw = await readFile(path.join(directory, 'package.json'), 'utf8');
        const parsed: unknown = JSON.parse(raw);
        if (
          typeof parsed === 'object' &&
          parsed !== null &&
          (parsed as { name?: unknown }).name === '@deepseek-ai/dsh' &&
          typeof (parsed as { version?: unknown }).version === 'string'
        ) {
          return (parsed as { version: string }).version;
        }
      } catch {
        // нет package.json на этом уровне
      }
      const parent = path.dirname(directory);
      if (parent === directory) {
        break;
      }
      directory = parent;
    }
  } catch {
    // путь не резолвится — версия неизвестна
  }
  return undefined;
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export type { AcpSessionSummary };

/** Статическая проверка: AcpRuntime полностью закрывает порт DshBridge. */
export type AcpRuntimeIsBridgePort = AcpRuntime extends DshBridgePort ? true : never;
export const acpRuntimeIsBridgePort: AcpRuntimeIsBridgePort = true;
