import {
  commandSpec,
  type CommandNode,
} from '../../../../packages/contracts/src/commands';
import {Fault, permission} from '../storage/store';
import type {CommandContext} from './command_context';
import {commandValue, validateCommandArguments} from './command_context';

import {identityQueries} from './command_identity_queries';
import {queryObject} from './command_object_queries';
import {playerQueries} from './command_player_queries';
import type {
  CommandQueryContext,
  CommandQueryHandler,
} from './command_query_context';
import {statistic} from './command_statistics';
import {systemQueries} from './command_system_queries';
import {queryTable, queryTables} from './command_table_queries';

export {page} from './command_pagination';
export {statistic} from './command_statistics';
export {queryTables} from './command_table_queries';

const queryHandlers: ReadonlyMap<string, CommandQueryHandler> = new Map([
  ...identityQueries,
  ...playerQueries,
  ...systemQueries,
]);

/** 执行已授权的注册查询并按职责隐藏秘密，不产生随机抽签或战局变更。 */
export function query(
  commandContext: CommandContext,
  commandNode: CommandNode,
): unknown {
  const spec = commandSpec(commandNode)!;
  permission(commandContext.actor, spec.permission);
  validateCommandArguments(commandNode);
  const engine = commandContext.engine;
  const words = commandNode.words;
  const commandArguments = words
    .slice(spec.path.split(' ').length)
    .map(v => commandValue(v, commandContext));
  const path = spec.path;
  const context: CommandQueryContext = {
    commandContext,
    commandNode,
    engine,
    words,
    commandArguments,
    path,
  };
  const handler = queryHandlers.get(path);
  if (handler) {
    return handler(context);
  }
  if (words[0] === 'stats') {
    return statistic(commandContext, commandNode);
  }
  if (
    ['case', 'schedule', 'macro', 'job', 'export', 'template'].includes(
      words[0]!,
    ) ||
    path === 'hunt draft inspect'
  ) {
    return queryObject(context);
  }
  const config = queryTables[words[0]!];
  if (config) {
    return queryTable(context, config);
  }
  throw new Fault(400, 'UNKNOWN_QUERY', '查询路径未注册。');
}
