import {COMMAND_LIMITS} from '../../../../packages/contracts/src/commands';
import type {Match, Store} from '../storage/store';
import {Fault} from '../storage/store';
import type {CommandContext} from './command_context';
import {recordChange, selectTargets} from './command_context';
import type {Engine} from './engine';

/** 同一命令事务捕获的状态、参数及来源，逐人处理仍消费共同工作预算。 */
export interface CommandPlayerContext {
  readonly commandContext: CommandContext;
  readonly engine: Engine;
  readonly db: Store;
  readonly matchState: Match;
  readonly path: string;
  readonly commandArguments: string[];
  readonly source: string;
}
/** 一次解析并稳定遍历目标，逐人核对预算及前后事实，不新建事务。 */
export function forEachCommandPlayer(
  context: CommandPlayerContext,
  action: (id: string) => void,
  pool = false,
): string[] {
  const {commandContext, commandArguments, db} = context;

  const ids = selectTargets(commandContext, commandArguments[0]!, pool);
  for (const id of ids) {
    if (++commandContext.work > COMMAND_LIMITS.work) {
      throw new Fault(
        413,
        'COMMAND_BUDGET',
        '一次提交的操作过多，请缩小范围，或添加 --mode sequential 分步执行。',
      );
    }
    const before = {
      player: db.player(id),
      flight: db.flight(id),
      home: db.home(id) ?? null,
    };
    action(id);
    recordChange(commandContext, id, before, {
      player: db.player(id),
      flight: db.flight(id),
      home: db.home(id) ?? null,
    });
  }
  if (!ids.length) {
    commandContext.notes.push('0人，无变化。');
  }
  return ids;
}
