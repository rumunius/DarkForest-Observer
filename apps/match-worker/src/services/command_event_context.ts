import type {CommandNode} from '../../../../packages/contracts/src/commands';
import type {Actor, Scheduled} from '../storage/store';
import type {CommandContext, SavedCommandObject} from './command_context';
import {run} from './command_runtime';
import type {Engine} from './engine';

/** createSchedule/createJob保存的事件标识和步骤位置，仍由入口核对原对象。 */
export interface CommandEventPayload {
  id?: string;
  job?: string;
  index?: number;
}
/** 已检查任务状态和创建者的原事件材料，共用一次执行上下文。 */
export interface CommandEventContext {
  readonly engine: Engine;
  readonly event: Scheduled;
  readonly payload: CommandEventPayload;
  readonly row: SavedCommandObject;
  readonly actor: Actor;
  readonly commandContext: CommandContext;
}
/** 在同步子事务内运行一个完整步骤，任何退出路径都恢复整批标记。 */
export function runCommandEventStep(
  commandContext: CommandContext,
  node: CommandNode,
): unknown {
  const engine = commandContext.engine;
  return engine.db.tx(() => {
    const prior = engine.commandBatch;
    engine.commandBatch = true;
    try {
      return run(commandContext, node);
    } finally {
      engine.commandBatch = prior;
    }
  });
}
