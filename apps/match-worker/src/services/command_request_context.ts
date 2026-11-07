import type {
  CommandNode,
  CommandSpec,
} from '../../../../packages/contracts/src/commands';
import type {Actor} from '../storage/store';
import type {CommandContext} from './command_context';
import type {Engine, PreparedCode} from './engine';

/** 本次已通过共同命令鉴权的请求材料，原文密文始终随请求传递。 */
export interface CommandRequestContext {
  readonly engine: Engine;
  readonly actor: Actor;
  readonly id: string;
  readonly path: string;
  readonly raw: Record<string, unknown>;
  readonly prepared: PreparedCode[];
  readonly ciphertext: string | null;
}
/** 去除显式plan包装并解析原因后的执行材料，不重新选择命令或操作者。 */
export interface CommandExecutionContext extends CommandRequestContext {
  readonly node: CommandNode;
  readonly spec: CommandSpec;
  readonly reason: string;
  readonly executionContext: CommandContext;
}
