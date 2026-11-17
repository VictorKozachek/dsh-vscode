/**
 * Контроллер диалога New Session (#023): собирает форму, валидирует, создаёт
 * сессию через порт и запоминает выбор. Без `vscode` — тесты с мок-портами
 * (`tests/new-session-controller.test.mjs`).
 */

import {
  buildCreateOptions,
  buildNewSessionValues,
  hasErrors,
  mergeModels,
  mergePresets,
  rememberedFromValues,
  validateNewSession,
  type NewSessionForm,
  type ApprovalChoice,
  type SandboxChoice,
  type NewSessionSettings,
  type NewSessionValues,
  type PresetOption,
  type RememberedNewSession
} from './newSessionModel';

/** Что нужно контроллеру. */
export interface NewSessionPorts {
  /** Пресеты рантайма (`standard` добавит модель). */
  getPresets(): Promise<readonly PresetOption[]> | readonly PresetOption[];
  /** Модели профиля. */
  getModels(preset: string): Promise<readonly string[]> | readonly string[];
  /** Создание в рантайме; бросает при ошибке. */
  create(options: {
    readonly preset: string;
    readonly model: string;
    readonly sandbox: SandboxChoice;
    readonly approval: ApprovalChoice;
    readonly title: string;
  }): Promise<{ readonly sessionId: string }>;
  getSettings(): NewSessionSettings;
  getRemembered(): RememberedNewSession;
  remember(values: RememberedNewSession): Promise<void> | void;
  readonly view: NewSessionViewPort;
}

/** Куда рисуется форма. */
export interface NewSessionViewPort {
  open(form: NewSessionForm): void;
  update(form: NewSessionForm): void;
  close(): void;
}

/** Настройки контроллера. */
export interface NewSessionControllerOptions extends NewSessionPorts {
  readonly now?: (() => Date) | undefined;
  readonly logger?: ((line: string) => void) | undefined;
  /** Уведомление о созданной сессии (в т.ч. созданной после отмены формы). */
  readonly notifyCreated?: ((sessionId: string) => void) | undefined;
}

/** Диалог создания сессии. */
export class NewSessionController {
  readonly #ports: NewSessionControllerOptions;
  readonly #now: () => Date;
  readonly #log: (line: string) => void;
  #presets: readonly PresetOption[] = [];
  #models: readonly string[] = [];
  #values: NewSessionValues | undefined;
  #chain: Promise<unknown> = Promise.resolve();
  #open = false;
  /** Поколение формы: open/cancel инвалидируют незавершённые операции. */
  #generation = 0;

  constructor(options: NewSessionControllerOptions) {
    this.#ports = options;
    this.#now = options.now ?? (() => new Date());
    this.#log = options.logger ?? (() => undefined);
  }

  get isOpen(): boolean {
    return this.#open;
  }

  /** Открыть форму: пресеты/модели из рантайма, значения из настроек/памяти. */
  open(): Promise<void> {
    const generation = ++this.#generation;
    return this.#enqueue(async () => {
      if (generation !== this.#generation) {
        return;
      }
      let presets;
      let models;
      try {
        presets = mergePresets(await this.#ports.getPresets());
        models = mergeModels(
          await this.#ports.getModels(presets[0]?.id ?? 'standard'),
          this.#ports.getSettings().defaultModel
        );
      } catch (error) {
        if (generation !== this.#generation) {
          return;
        }
        const message = error instanceof Error ? error.message : String(error);
        this.#log(`New Session: не удалось получить пресеты/модели: ${message}`);
        presets = mergePresets([]);
        models = mergeModels([], this.#ports.getSettings().defaultModel);
        const fallback = buildNewSessionValues({
          settings: this.#ports.getSettings(),
          remembered: this.#ports.getRemembered()
        });
        this.#presets = presets;
        this.#models = models;
        this.#values = { ...fallback, model: preferredModel(models, fallback.model) };
        this.#open = true;
        this.#ports.view.open({
          presets,
          models,
          values: this.#values,
          errors: { form: message }
        });
        return;
      }
      if (generation !== this.#generation) {
        return;
      }
      const defaults = buildNewSessionValues({
        settings: this.#ports.getSettings(),
        remembered: this.#ports.getRemembered()
      });
      const values: NewSessionValues = {
        ...defaults,
        preset: presets.some((preset) => preset.id === defaults.preset)
          ? defaults.preset
          : 'standard'
      };
      this.#presets = presets;
      this.#models = models;
      this.#values = { ...values, model: preferredModel(models, values.model) };
      this.#open = true;
      this.#ports.view.open({
        presets,
        models,
        values: this.#values,
        errors: {}
      });
    });
  }

  /** Отправить форму: валидация → создание → запоминание → закрыть. */
  submit(values: NewSessionValues): Promise<void> {
    const generation = this.#generation;
    return this.#enqueue(async () => {
      if (!this.#open || generation !== this.#generation) {
        return;
      }
      const errors = validateNewSession(values, {
        presets: this.#presets,
        models: this.#models
      });
      if (hasErrors(errors)) {
        this.#values = values;
        this.#ports.view.update({
          presets: this.#presets,
          models: this.#models,
          values,
          errors
        });
        return;
      }

      const options = buildCreateOptions(values, this.#now());
      try {
        const created = await this.#ports.create(options);
        // Отмена во время создания: сессия уже есть, форму не «закрываем»
        // повторно, но и ошибкой это не считаем.
        if (generation !== this.#generation) {
          // Отмена не отменяет уже начатое создание: сообщаем о сессии явно.
          this.#log(`New Session: сессия ${created.sessionId} создана после отмены`);
          this.#ports.notifyCreated?.(created.sessionId);
          return;
        }
        try {
          await this.#ports.remember(rememberedFromValues(values));
        } catch (error) {
          // Сессия уже создана: ошибка запоминания не должна ломать форму.
          this.#log(
            `New Session: не удалось запомнить значения: ${error instanceof Error ? error.message : String(error)}`
          );
        }
        this.#open = false;
        this.#values = undefined;
        this.#log(`New Session: создана сессия ${created.sessionId}`);
        this.#ports.view.close();
        this.#ports.notifyCreated?.(created.sessionId);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.#log(`New Session: ошибка создания: ${message}`);
        if (generation !== this.#generation) {
          return;
        }
        this.#values = values;
        this.#ports.view.update({
          presets: this.#presets,
          models: this.#models,
          values,
          errors: { form: message }
        });
      }
    });
  }

  /** Отмена/закрытие формы. */
  cancel(): void {
    if (!this.#open) {
      this.#generation += 1;
      return;
    }
    this.#generation += 1;
    this.#open = false;
    this.#values = undefined;
    this.#ports.view.close();
  }

  #enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.#chain.then(operation, operation);
    this.#chain = result.then(
      () => undefined,
      () => undefined
    );
    return result as Promise<T>;
  }
}

/** Последняя выбранная модель, если она есть в списке; иначе первая. */
function preferredModel(models: readonly string[], candidate: string): string {
  return models.includes(candidate) ? candidate : (models[0] ?? candidate);
}
