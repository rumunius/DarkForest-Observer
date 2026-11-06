import type {SiteConfig} from '@darkforest/contracts';
import {parseJson} from '../../../../packages/contracts/src/backend';
import {matchProjection} from '../projections/snapshot';
import {accountList} from './accounts';
import {parameterKeys, requireCommandArgument} from './command_context';
import {survivors} from './life';

import {page} from './command_pagination';
import type {
  CommandQueryContext,
  CommandQueryHandler,
} from './command_query_context';

/** 读取服务端比赛与时钟投影。 */
function queryMatchStatus(context: CommandQueryContext): unknown {
  const {engine} = context;

  return matchProjection(engine);
}

/** 分页读取已记录的暂停区间。 */
function queryClockPauses(context: CommandQueryContext): unknown {
  const {commandContext, commandNode} = context;

  return page(commandContext, commandNode, 'clock_pauses');
}

/** 读取调度健康与尚未结算的持久故障。 */
function querySchedulerHealth(context: CommandQueryContext): unknown {
  const {engine} = context;

  return {
    health: engine.db.one<Record<string, SqlStorageValue>>(
      'SELECT * FROM scheduler_health',
    ),
    failed: engine.db.all<Record<string, SqlStorageValue>>(
      "SELECT id,last_error,last_error_utc,attempt_count FROM scheduled_events WHERE last_error<>'' AND status='pending'",
    ),
  };
}

/** 读取终局阶段、暂停核验和当前存活名单。 */
function queryHuntStatus(context: CommandQueryContext): unknown {
  const {engine} = context;

  return {
    phase: engine.db.match().phase,
    paused: engine.db.match().pause_reason,
    finalized: engine.db.match().hunt_finalized,
    alive: survivors(engine),
  };
}

/** 读取合并默认值后的赛前规则参数。 */
function queryParameters(context: CommandQueryContext): unknown {
  const {engine} = context;

  return engine.db.parameters();
}

/** 在已注册参数键内返回当前值及业务范围。 */
function inspectParameter(context: CommandQueryContext): unknown {
  const {engine, commandArguments} = context;

  requireCommandArgument(commandArguments[0]! in parameterKeys, '未知参数');
  return {
    key: commandArguments[0],
    value:
      engine.db.parameters()[
        parameterKeys[commandArguments[0]!] as keyof ReturnType<
          typeof engine.db.parameters
        >
      ],
    range: commandArguments[0]!.includes('percent')
      ? '0—100'
      : commandArguments[0] === 'sighting-min-interval'
        ? '1—60000毫秒'
        : commandArguments[0] === 'sighting-per-minute'
          ? '1—120'
          : commandArguments[0] === 'observer-wait'
            ? '0—86400秒'
            : '1—86400秒',
  };
}

/** 读取站点设置或七色显示配置。 */
function querySettings(context: CommandQueryContext): unknown {
  const {engine, path} = context;

  const site = parseJson(engine.db.match().site_json) as SiteConfig;
  return path === 'palette list' ? site.colors : site;
}

/** 通过账号领域服务生成脱敏列表或单账号资料。 */
function queryAccounts(context: CommandQueryContext): unknown {
  const {commandContext, engine, commandArguments, path} = context;

  const accounts = accountList(engine, commandContext.actor);
  return path.endsWith('list')
    ? accounts
    : (accounts.find(x => x.id === commandArguments[0]) ?? null);
}

/** 只读取账号会话的期限与撤销概况。 */
function querySessions(context: CommandQueryContext): unknown {
  const {engine, commandArguments} = context;

  return engine.db.all<Record<string, SqlStorageValue>>(
    'SELECT account_id,expires,revoked FROM sessions WHERE account_id=?',
    commandArguments[0]!,
  );
}

/** 读取恢复核对状态与现场检查项目，不推进恢复。 */
function queryRecovery(context: CommandQueryContext): unknown {
  const {engine} = context;

  return {
    state: engine.db.match().recovery_state,
    match: matchProjection(engine),
    checklist: [
      '核对实际阶段与暂停',
      '核对有效手环配置',
      '核对已传播信息和QQ通知',
      '核对待办与失败事件',
    ],
  };
}

/** 本模块职责内的固定只读路径；共同权限检查仍由查询入口执行。 */
export const systemQueries: ReadonlyMap<string, CommandQueryHandler> = new Map([
  ['clock status', queryMatchStatus],
  ['match status', queryMatchStatus],
  ['clock pauses', queryClockPauses],
  ['scheduler health', querySchedulerHealth],
  ['hunt status', queryHuntStatus],
  ['parameter list', queryParameters],
  ['parameter inspect', inspectParameter],
  ['setting list', querySettings],
  ['palette list', querySettings],
  ['account list', queryAccounts],
  ['account inspect', queryAccounts],
  ['session list', querySessions],
  ['recovery status', queryRecovery],
  ['recovery checklist', queryRecovery],
]);
