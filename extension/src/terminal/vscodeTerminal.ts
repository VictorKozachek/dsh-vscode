/**
 * VS Code-адаптер терминала (#015): Window Terminal + shell integration.
 * Тонкая обёртка, чтобы `TerminalBridge` оставался тестируемым без VS Code.
 */

import * as vscode from 'vscode';

import type { TerminalExecution, TerminalSession } from './terminalBridge';

export function createVscodeTerminalSession(input: {
  readonly cwd: string | undefined;
  readonly name: string;
}): TerminalSession {
  const terminal = vscode.window.createTerminal({
    name: input.name,
    ...(input.cwd === undefined ? {} : { cwd: input.cwd })
  });
  terminal.show(true);
  const integration = terminal.shellIntegration;
  return {
    shellIntegrationAvailable: integration !== undefined,
    execute(command: string): TerminalExecution | undefined {
      const current = terminal.shellIntegration;
      if (current === undefined) {
        return undefined;
      }
      const execution = current.executeCommand(command);
      // exitCode приходит событием onDidEndTerminalShellExecution (в @types
      // vscode 1.100 у TerminalShellExecution нет поля exitCode).
      const exitCode = new Promise<number | undefined>((resolve) => {
        const subscription = vscode.window.onDidEndTerminalShellExecution?.((event) => {
          if (event.execution === execution) {
            subscription?.dispose();
            resolve(event.exitCode);
          }
        });
      });
      return {
        async *read() {
          for await (const chunk of execution.read()) {
            yield chunk;
          }
        },
        exitCode
      };
    },
    dispose(): void {
      terminal.dispose();
    }
  };
}

export type TerminalSessionFactory = typeof createVscodeTerminalSession;
