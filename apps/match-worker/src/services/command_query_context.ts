import type {CommandNode} from '../../../../packages/contracts/src/commands';
import type {CommandContext} from './command_context';
import type {Engine} from './engine';

/** 共同授权及参数校验之后的一次只读命令；不另取目标或生成随机结果。 */
export interface CommandQueryContext {
  readonly commandContext: CommandContext;
  readonly commandNode: CommandNode;
  readonly engine: Engine;
  readonly words: string[];
  readonly commandArguments: string[];
  readonly path: string;
}
/** 返回一项已授权查询的原有结果形状，具体职责裁剪由处理器执行。 */
export type CommandQueryHandler = (context: CommandQueryContext) => unknown;
