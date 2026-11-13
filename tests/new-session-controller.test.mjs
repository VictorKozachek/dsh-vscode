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
  assert.equal(calls.update[0].errors.model, 'Выберите модель');
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
  assert.match(calls.update[0].errors.sandbox, /подтверждения/);
});

test('cancel закрывает форму; запомненный несуществующий пресет → standard', async () => {
  const { controller, calls } = harness({ remembered: { preset: 'gone' } });
  await controller.open();
  assert.equal(calls.open[0].values.preset, 'standard');

  controller.cancel();
  assert.equal(calls.close, 1);
  assert.equal(controller.isOpen, false);
});
