import {
  COMMAND_LIMITS,
  COMMAND_SPECS,
  LANGUAGE_VERSION,
} from '../../../../packages/contracts/src/commands';
import {accountPermissions} from '../storage/store';
import {targets} from './command_targets';

import type {
  CommandQueryContext,
  CommandQueryHandler,
} from './command_query_context';

/** 按当前职责生成可用命令帮助，不泄露未授权命令内容。 */
function queryHelp(context: CommandQueryContext): unknown {
  const {commandContext, commandArguments} = context;

  return COMMAND_SPECS.filter(
    s => !commandArguments[0] || s.path.startsWith(commandArguments[0]),
  )
    .filter(s =>
      accountPermissions(commandContext.actor).includes(s.permission),
    )
    .map(s => ({
      command: `/${s.path} ${s.args}`.trim(),
      description: s.description,
      preview: !s.query && !s.direct,
    }));
}

/** 返回实际命令语言版本及执行预算。 */
function queryVersion(): unknown {
  return {
    language: LANGUAGE_VERSION,
    implementation: 1,
    limits: COMMAND_LIMITS,
  };
}

/** 返回本场账号及职责，不包含凭据。 */
function queryIdentity(context: CommandQueryContext): unknown {
  const {commandContext, engine} = context;

  return {
    actor: commandContext.actor.id,
    match: engine.db.match().id,
    permissions: accountPermissions(commandContext.actor),
  };
}

/** 只解释选择器候选及随机性，查询不进行抽签。 */
function inspectSelector(context: CommandQueryContext): unknown {
  const {commandContext, engine, commandArguments} = context;

  const targetSet = targets(
    engine,
    commandArguments[0]!,
    commandContext.self,
    true,
    commandContext.bindings,
  );
  return {
    candidates: targetSet.candidates,
    count: targetSet.count,
    random: targetSet.random,
    draw: '查询不抽人',
  };
}

/** 本模块职责内的固定只读路径；共同权限检查仍由查询入口执行。 */
export const identityQueries: ReadonlyMap<string, CommandQueryHandler> =
  new Map([
    ['help', queryHelp],
    ['version', queryVersion],
    ['whoami', queryIdentity],
    ['capability list', queryIdentity],
    ['selector inspect', inspectSelector],
  ]);
