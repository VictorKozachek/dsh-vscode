import assert from 'node:assert/strict';
import { register } from 'node:module';
import test from 'node:test';

register('./helpers/ts-loader.mjs', import.meta.url);
const { NewSessionController } = await import('../extension/src/views/newSessionController.ts');

const NOW = new Date(2026, 10, 13, 22, 30);

function harness({ presets = [], models = ['deepseek-chat'], createError = null, settings = {}, remembered = {} } = {}) {
  const calls = { create: [], remember: [], open: [], update: [], close: 0 };
  const controller = new NewSessionController({
    getPresets: () => presets,
    getModels: () => models,
    create: async (options) => {
      calls.create.push(options);
      if (createError !== null) {
        throw new Error(createError);
      }
      return { sessionId: 'sess-1' };
    },
    getSettings: () => settings,
    getRemembered: () => remembered,
    remember: (values) => {
      calls.remember.push(values);
    },
    view: {
      open: (form) => calls.open.push(form),
      update: (form) => calls.update.push(form),
      close: () => {
        calls.close += 1;
      }
    },
    now: () => NOW
  });
  return { controller, calls };
}

const validValues = {
  preset: 'standard',
  model: 'deepseek-chat',
  sandbox: 'workspace-write',
  approval: 'ask',
  title: '',
  confirmDanger: false
};

test('open: пресеты с standard, модели, значения из настроек', async () => {
  const { controller, calls } = harness({
    presets: [{ id: 'worker', title: 'worker', description: 'Исполнитель' }],
    settings: { defaultModel: 'deepseek-v4', sandboxMode: 'read-only', approvalPolicy: 'auto' }
  });

  await controller.open();
  assert.equal(calls.open.length, 1);
  const form = calls.open[0];
  assert.deepEqual(form.presets.map((preset) => preset.id), ['standard', 'worker']);
  assert.deepEqual(form.models, ['deepseek-v4', 'deepseek-chat']);
  assert.equal(form.values.preset, 'standard');
  assert.equal(form.values.sandbox, 'read-only');
  assert.equal(form.values.approval, 'auto');
  assert.equal(controller.isOpen, true);
});

test('submit невалидной формы: ошибки, create не вызывается', async () => {
  const { controller, calls } = harness();
  await controller.open();

  await controller.submit({ ...validValues, model: '' });
  assert.equal(calls.create.length, 0);
  assert.equal(calls.update.length, 1);
  assert.equal(calls.update[0].errors.model, 'newSession.error.modelRequired');
  assert.equal(calls.close, 0);
  assert.equal(controller.isOpen, true);
});

test('submit валидной формы: create → remember → close', async () => {
  const { controller, calls } = harness();
  await controller.open();

  await controller.submit({ ...validValues, preset: 'standard', title: 'Мой чат' });
  assert.deepEqual(calls.create, [
    {
      preset: 'standard',
      model: 'deepseek-chat',
      sandbox: 'workspace-write',
      approval: 'ask',
      title: 'Мой чат'
    }
  ]);
  assert.equal(calls.remember.length, 1);
  assert.equal(calls.remember[0].preset, 'standard');
  assert.equal(calls.close, 1);
  assert.equal(controller.isOpen, false);
});

test('ошибка рантайма показывается в форме, панель жива', async () => {
  const { controller, calls } = harness({ createError: 'spawn ENOENT' });
  await controller.open();

  await controller.submit(validValues);
  assert.equal(calls.close, 0);
  assert.equal(calls.update.length, 1);
  assert.match(calls.update[0].errors.form, /spawn ENOENT/);
  assert.equal(controller.isOpen, true);
});

test('danger-full-access без подтверждения не создаёт сессию', async () => {
  const { controller, calls } = harness();
  await controller.open();

  await controller.submit({ ...validValues, sandbox: 'danger-full-access' });
  assert.equal(calls.create.length, 0);
  assert.match(calls.update[0].errors.sandbox, /dangerConfirm/);
});

test('cancel закрывает форму; запомненный несуществующий пресет → standard', async () => {
  const { controller, calls } = harness({ remembered: { preset: 'gone' } });
  await controller.open();
  assert.equal(calls.open[0].values.preset, 'standard');

  controller.cancel();
  assert.equal(calls.close, 1);
  assert.equal(controller.isOpen, false);
});

test('ошибка загрузки пресетов/моделей показывается в форме', async () => {
  const calls = { open: [], update: [], close: 0, create: [] };
  const controller = new NewSessionController({
    getPresets: async () => {
      throw new Error('runtime offline');
    },
    getModels: async () => [],
    create: async (options) => {
      calls.create.push(options);
      return { sessionId: 'sess-1' };
    },
    getSettings: () => ({ defaultModel: 'deepseek-chat' }),
    getRemembered: () => ({}),
    remember: () => undefined,
    view: {
      open: (form) => calls.open.push(form),
      update: (form) => calls.update.push(form),
      close: () => {
        calls.close += 1;
      }
    }
  });

  await controller.open();
  assert.equal(calls.open.length, 1);
  assert.match(calls.open[0].errors.form, /runtime offline/);
  assert.deepEqual(calls.open[0].presets.map((preset) => preset.id), ['standard']);
  assert.equal(controller.isOpen, true);
  controller.dispose?.();
});

test('cancel во время открытия отменяет форму; submit после cancel не создаёт', async () => {
  let resolvePresets;
  const opened = [];
  const controller = new NewSessionController({
    getPresets: () =>
      new Promise((resolve) => {
        resolvePresets = resolve;
      }),
    getModels: () => ['deepseek-chat'],
    create: async () => ({ sessionId: 'sess-1' }),
    getSettings: () => ({}),
    getRemembered: () => ({}),
    remember: () => undefined,
    view: {
      open: (form) => opened.push(form),
      update: () => undefined,
      close: () => undefined
    }
  });

  const opening = controller.open();
  await new Promise((resolve) => setImmediate(resolve));
  controller.cancel();
  resolvePresets([{ id: 'worker', title: 'worker' }]);
  await opening;
  assert.equal(opened.length, 0, 'форма не открылась после отмены');

  const created = [];
  const second = new NewSessionController({
    getPresets: () => [],
    getModels: () => ['deepseek-chat'],
    create: async (options) => {
      created.push(options);
      return { sessionId: 'sess-2' };
    },
    getSettings: () => ({}),
    getRemembered: () => ({}),
    remember: () => undefined,
    view: { open: () => undefined, update: () => undefined, close: () => undefined }
  });
  await second.open();
  second.cancel();
  await second.submit({
    preset: 'standard',
    model: 'deepseek-chat',
    sandbox: 'workspace-write',
    approval: 'ask',
    title: '',
    confirmDanger: false
  });
  assert.equal(created.length, 0, 'submit после cancel не создаёт сессию');
});

test('ошибка запоминания не ломает уже созданную сессию', async () => {
  const calls = { close: 0, update: [] };
  const controller = new NewSessionController({
    getPresets: () => [],
    getModels: () => ['deepseek-chat'],
    create: async () => ({ sessionId: 'sess-1' }),
    getSettings: () => ({}),
    getRemembered: () => ({}),
    remember: () => {
      throw new Error('globalState недоступен');
    },
    view: {
      open: () => undefined,
      update: (form) => calls.update.push(form),
      close: () => {
        calls.close += 1;
      }
    }
  });

  await controller.open();
  await controller.submit({
    preset: 'standard',
    model: 'deepseek-chat',
    sandbox: 'workspace-write',
    approval: 'ask',
    title: '',
    confirmDanger: false
  });

  assert.equal(calls.close, 1, 'форма закрыта');
  assert.equal(calls.update.length, 0, 'ошибка запоминания не показана как ошибка создания');
});

test('ошибка загрузки пресетов после cancel не открывает форму', async () => {
  let rejectPresets;
  const opened = [];
  const controller = new NewSessionController({
    getPresets: () =>
      new Promise((_resolve, reject) => {
        rejectPresets = reject;
      }),
    getModels: () => ['deepseek-chat'],
    create: async () => ({ sessionId: 'sess-1' }),
    getSettings: () => ({}),
    getRemembered: () => ({}),
    remember: () => undefined,
    view: { open: (form) => opened.push(form), update: () => undefined, close: () => undefined }
  });

  const opening = controller.open();
  await new Promise((resolve) => setImmediate(resolve));
  controller.cancel();
  rejectPresets(new Error('runtime offline'));
  await opening;
  assert.equal(opened.length, 0, 'форма не открылась после отмены');
});

test('cancel во время создания: сессия создаётся и пользователь уведомлён', async () => {
  let resolveCreate;
  const created = [];
  const notified = [];
  let closes = 0;
  const controller = new NewSessionController({
    getPresets: () => [],
    getModels: () => ['deepseek-chat'],
    create: () =>
      new Promise((resolve) => {
        resolveCreate = resolve;
      }),
    getSettings: () => ({}),
    getRemembered: () => ({}),
    remember: () => undefined,
    view: {
      open: () => undefined,
      update: () => undefined,
      close: () => {
        closes += 1;
      }
    },
    notifyCreated: (sessionId) => notified.push(sessionId)
  });

  await controller.open();
  const submitting = controller.submit({
    preset: 'standard',
    model: 'deepseek-chat',
    sandbox: 'workspace-write',
    approval: 'ask',
    title: '',
    confirmDanger: false
  });
  await new Promise((resolve) => setImmediate(resolve));
  controller.cancel();
  resolveCreate({ sessionId: 'sess-late' });
  await submitting;

  assert.equal(closes, 1, 'форму закрыл cancel');
  assert.deepEqual(notified, ['sess-late'], 'о созданной сессии сообщили');
  void created;
});

test('open: последняя выбранная модель восстанавливается, если она в списке', async () => {
  const { controller, calls } = harness({
    models: ['deepseek-chat', 'custom-model'],
    settings: { defaultModel: 'deepseek-chat' },
    remembered: {
      preset: 'worker',
      model: 'custom-model',
      sandbox: 'read-only',
      approval: 'never'
    }
  });

  await controller.open();
  const form = calls.open[0];
  assert.equal(form.values.model, 'custom-model');
  assert.equal(form.values.preset, 'standard', 'пресет из памяти проверяется по списку');
  assert.equal(form.values.sandbox, 'read-only');
  assert.equal(form.values.approval, 'never');
});

test('open после ошибки получения моделей тоже предпочитает remembered model', async () => {
  const controller = new NewSessionController({
    getPresets: () => {
      throw new Error('runtime down');
    },
    getModels: () => [],
    create: async () => ({ sessionId: 'sess-1' }),
    getSettings: () => ({ defaultModel: 'deepseek-chat' }),
    getRemembered: () => ({ model: 'custom-model' }),
    remember: () => undefined,
    view: { open: () => undefined, update: () => undefined, close: () => undefined },
    now: () => NOW
  });
  const opened = [];
  // отдельный harness с view, чтобы прочитать форму
  const controller2 = new NewSessionController({
    getPresets: () => {
      throw new Error('runtime down');
    },
    getModels: () => [],
    create: async () => ({ sessionId: 'sess-1' }),
    getSettings: () => ({ defaultModel: 'custom-model' }),
    getRemembered: () => ({ model: 'custom-model' }),
    remember: () => undefined,
    view: { open: (form) => opened.push(form), update: () => undefined, close: () => undefined },
    now: () => NOW
  });
  await controller.open();
  await controller2.open();
  assert.equal(opened[0].values.model, 'custom-model');
  assert.match(opened[0].errors.form ?? '', /runtime down/);
});
