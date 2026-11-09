/**
 * Статическая проверка: `DshBridge` (#004) структурно удовлетворяет порту
 * `DshBridgePort`, который использует SessionManager. Если сигнатуры разойдутся,
 * `pnpm typecheck` упадёт здесь — до того, как это заметит #011 при проводке.
 */

import type { DshBridge } from '../bridge/dshBridge';
import type { DshBridgePort } from './sessionManager';

/** `true`, если мост подходит к порту; `never` — если нет (ошибка компиляции). */
export type BridgeSatisfiesSessionPort = DshBridge extends DshBridgePort ? true : never;

export const bridgeSatisfiesSessionPort: BridgeSatisfiesSessionPort = true;
