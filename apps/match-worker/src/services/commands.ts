import type {OperationResult} from '@darkforest/contracts';
import {strict, text} from '../../../../packages/contracts/src/backend';
import {
  COMMAND_LIMITS,
  commandSpec,
  parseCommandTree,
  type CommandNode,
} from '../../../../packages/contracts/src/commands';
import {permission, requireThat, type Actor} from '../storage/store';
import {prepareCredential} from './accounts';
import {
  requireCommandArgument,
  validateCommandOptions,
} from './command_context';
import {
  confirmCommandPlan,
  inspectCommandPlan,
  previewCommandRequest,
} from './command_plans';
import {page, queryTables} from './command_query';
import type {
  CommandExecutionContext,
  CommandRequestContext,
} from './command_request_context';
import {
  inspectCommandRequest,
  queryCommandRequest,
  saveDirectCommand,
} from './command_request_reads';
import {createCommandContext, pin} from './command_runtime';
import {type Engine, type PreparedCode} from './engine';

export {recordCommand} from './command_audit';
export {condition} from './command_conditions';

/** 通过受限分页器读取真实命令日志，不开放任意SQL或跨权限历史。 */
export function readCommandHistory(
  engine: Engine,
  actor: Actor,
  options: Record<string, string> = {},
): unknown {
  permission(actor, 'audit');
  const node: CommandNode = {words: ['command', 'history'], options};
  validateCommandOptions(node);
  return page(
    createCommandContext(engine, actor, 'history-read', []),
    node,
    'judge_command_log',
    queryTables.command!.columns,
  );
}

/** 共享命令语法解析入口；解析成功不代表已经授权或执行。 */
export const parseCommand = parseCommandTree;

/** 处理查询、预览、确认与取消；执行时在权威事务中复核依赖和权限。 */
export function commandAction(
  engine: Engine,
  actor: Actor,
  id: string,
  path: string,
  raw: Record<string, unknown>,
  prepared: PreparedCode[],
  keys: Awaited<ReturnType<Engine['keys']>>,
  ciphertext: string | null = null,
): OperationResult {
  engine.resolvedKeys = keys;
  requireThat(
    actor.role === 'judge',
    'FORBIDDEN',
    '只有裁判可以执行指令。',
    403,
  );
  permission(actor, 'overview');
  strict(raw, [
    'request_id',
    'command',
    'reason',
    'expected_revision',
    'preview_token',
  ]);
  let node = parseCommandTree(text(raw.command, COMMAND_LIMITS.bytes));
  let spec = commandSpec(node);
  requireCommandArgument(spec, '无法识别命令，请输入/help');
  const context: CommandRequestContext = {
    engine,
    actor,
    id,
    path,
    raw,
    prepared,
    ciphertext,
  };
  if (node.words[0] === 'request') {
    return inspectCommandRequest(context, node, spec);
  }
  if (
    node.words[0] === 'plan' &&
    ['inspect', 'cancel'].includes(node.words[1]!)
  ) {
    return inspectCommandPlan(context, node, spec);
  }
  if (node.words[0] === 'confirm' || raw.preview_token) {
    return confirmCommandPlan(context, node);
  }
  let explicit = node.words[0] === 'plan';
  if (explicit) {
    node = {...node, words: node.words.slice(1)};
    spec = commandSpec(node);
    requireCommandArgument(spec && !spec.query, 'plan需要一个写操作');
  }
  const reason =
    node.options.reason ??
    (typeof raw.reason === 'string' && raw.reason.trim()
      ? raw.reason
      : '裁判主动干预');
  const executionContext = createCommandContext(engine, actor, id, prepared);
  executionContext.reason = reason;
  const execution: CommandExecutionContext = {
    ...context,
    node,
    spec,
    reason,
    executionContext,
  };
  if (spec.query) {
    return queryCommandRequest(execution);
  }
  // Fixed macro versions are stored in the plan, never resolved again after confirmation.
  if (spec.path !== 'macro define') {
    pin(executionContext, node);
  }
  if (spec.direct && !explicit && !path.endsWith('/preview')) {
    return saveDirectCommand(execution);
  }
  explicit = explicit || path.endsWith('/preview');
  void explicit;
  return previewCommandRequest(execution);
}

/** 在事务外准备命令需要的凭据，执行时仍必须核对最新授权。 */
export async function prepareCommandCredentials(
  engine: Engine,
  creators: string[],
): Promise<void> {
  const accounts = engine.db.all<{id: string}>(
    "SELECT id FROM accounts WHERE instr(permissions,'system')=0",
  );
  const entries = await Promise.all(
    [...new Set(creators)].flatMap(actor =>
      accounts.map(
        async account =>
          [
            `${actor}:${account.id}`,
            await prepareCredential(engine, actor),
          ] as const,
      ),
    ),
  );
  engine.commandCredentials = Object.fromEntries(entries);
}

export {executeCommandEvent} from './command_events';
