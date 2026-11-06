import type {OperationResult} from '@darkforest/contracts';
import type {CommandSpec} from '../../../../packages/contracts/src/commands';
import {type CommandNode} from '../../../../packages/contracts/src/commands';
import {recordCommand} from './command_audit';
import {
  requireCommandArgument,
  validateCommandOptions,
} from './command_context';
import {query} from './command_query';
import type {
  CommandExecutionContext,
  CommandRequestContext,
} from './command_request_context';
import {actualTargets, commandState, run} from './command_runtime';
import {completed} from './engine';

/** 读取本人原操作结果并记录查询水位，不重新执行业务。 */
export function inspectCommandRequest(
  context: CommandRequestContext,
  node: CommandNode,
  spec: CommandSpec,
): OperationResult {
  const {engine, actor, id, ciphertext} = context;

  requireCommandArgument(
    node.words.length === 3 && node.words[1] === 'inspect',
    '用法：request inspect REQ-ID',
  );
  const result = engine.result(actor, node.words[2]!);
  recordCommand(
    engine,
    actor,
    id,
    spec.path,
    'queried',
    {
      reference: node.words[2],
      watermark: engine.db.match().revision,
      resultStatus: result.status,
    },
    ciphertext,
  );
  return result;
}

/** 记录职责内查询的条件、字段投影和数量，不复制查询秘密正文。 */
export function queryCommandRequest(
  context: CommandExecutionContext,
): OperationResult {
  const {engine, actor, id, ciphertext, node, spec, executionContext} = context;

  validateCommandOptions(node);
  const result = query(executionContext, node);
  recordCommand(
    engine,
    actor,
    id,
    spec.path,
    'queried',
    {
      watermark: engine.db.match().revision,
      projection: spec.path,
      count: Array.isArray(result)
        ? result.length
        : result &&
            typeof result === 'object' &&
            'items' in result &&
            Array.isArray(result.items)
          ? result.items.length
          : 1,
      filters: Object.fromEntries(
        Object.entries(node.options).map(([key, value]) => [
          key,
          key === 'search' ? '检索词保存在加密原文' : value,
        ]),
      ),
      targets: Object.keys(executionContext.dependencies)
        .filter(key => key.startsWith('player:'))
        .map(key => key.slice(7)),
    },
    ciphertext,
  );
  return completed(id, '查询完成', JSON.stringify(result, null, 2));
}

/** 直接保存不改变正式战局的命令，并记录原前后状态及返回值。 */
export function saveDirectCommand(
  context: CommandExecutionContext,
): OperationResult {
  const {engine, actor, id, ciphertext, node, spec, reason, executionContext} =
    context;

  const stateBefore = commandState(engine);
  const result = run(executionContext, node);
  engine.db.bump();
  recordCommand(
    engine,
    actor,
    id,
    spec.path,
    'saved',
    {
      reason,
      source: executionContext.source,
      targets: actualTargets(executionContext.changes),
      changes: executionContext.changes,
      before: stateBefore,
      after: commandState(engine),
      result,
    },
    ciphertext,
  );
  return completed(
    id,
    '已保存',
    JSON.stringify({result, changes: executionContext.changes}),
  );
}
