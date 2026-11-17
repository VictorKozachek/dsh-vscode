/**
 * Опции VS Code-терминала для ACP terminal/create (#015): cwd/env из запроса
 * агента должны дойти до `window.createTerminal`. Чистая функция — тест без
 * VS Code.
 */

export interface TerminalLaunchInput {
  readonly name: string;
  readonly cwd?: string | undefined;
  readonly env?: Readonly<Record<string, string>> | undefined;
}

export interface TerminalLaunchOptions {
  readonly name: string;
  readonly cwd?: string;
  readonly env?: Record<string, string>;
}

export function buildTerminalOptions(input: TerminalLaunchInput): TerminalLaunchOptions {
  const env = input.env === undefined ? undefined : { ...input.env };
  return {
    name: input.name,
    ...(input.cwd === undefined ? {} : { cwd: input.cwd }),
    ...(env === undefined || Object.keys(env).length === 0 ? {} : { env })
  };
}
