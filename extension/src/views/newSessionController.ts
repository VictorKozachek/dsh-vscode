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
  type NewSessionErrors,
  type NewSessionForm,
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
    readonly sandbox: string;
    readonly approval: string;
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
    return this.#enqueue(async () => {
      const presets = mergePresets(await this.#ports.getPresets());
      const remembered = this.#ports.getRemembered();
      const defaults = buildNewSessionValues({
        settings: this.#ports.getSettings(),
        remembered
      });
      const values: NewSessionValues = {
        ...defaults,
        preset: presets.some((preset) => preset.id === defaults.preset)
          ? defaults.preset
          : 'standard'
      };
      const models = mergeModels(
        await this.#ports.getModels(values.preset),
        values.model
      );
      this.#presets = presets;
      this.#models = models;
      this.#values = { ...values, model: models[0] ?? values.model };
      this.#open = true;
      this.#ports.view.open({
        presets: this.#presets,
        models: this.#models,
        values: this.#values,
        errors: {}
      });
    });
  }

  /** Отправить форму: валидация → создание → запоминание → закрыть. */
  submit(values: NewSessionValues): Promise<void> {
    return this.#enqueue(async () => {
      if (!this.#open) {
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
        await this.#ports.remember(rememberedFromValues(values));
        this.#open = false;
        this.#values = undefined;
        this.#log(`New Session: создана сессия ${created.sessionId}`);
        this.#ports.view.close();
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.#log(`New Session: ошибка создания: ${message}`);
        const formErrors: NewSessionErrors = { form: message };
        this.#values = values;
        this.#ports.view.update({
          presets: this.#presets,
          models: this.#models,
          values,
          errors: formErrors
        });
      }
    });
  }

  /** Отмена/закрытие формы. */
  cancel(): void {
    if (!this.#open) {
      return;
    }
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
