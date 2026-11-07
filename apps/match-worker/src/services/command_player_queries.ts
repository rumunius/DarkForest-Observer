import {civilization, matchProjection} from '../projections/snapshot';
import {accountPermissions} from '../storage/store';
import {civilizationHistory} from './civilization_history';
import {singleTarget} from './command_context';
import {score} from './command_targets';

import {page} from './command_pagination';
import type {
  CommandQueryContext,
  CommandQueryHandler,
} from './command_query_context';

/** 按正式名单顺序返回文明编号与昵称。 */
function queryRoster(context: CommandQueryContext): unknown {
  const {engine} = context;

  return engine.db
    .roster()
    .map(id => ({id, nickname: engine.db.player(id).nickname}));
}

/** 读取正式名单的航次和母星审核状态。 */
function queryPreflight(context: CommandQueryContext): unknown {
  const {engine} = context;

  return engine.db.roster().map(id => ({
    id,
    flight: engine.db.flight(id),
    verified: engine.db.home(id)?.status === 'verified',
  }));
}

/** 用固定公开字段分页读取文明资料。 */
function queryPlayers(context: CommandQueryContext): unknown {
  const {commandContext, commandNode} = context;

  return page(
    commandContext,
    commandNode,
    'players',
    'id,nickname,entry_status,tech,photons,broadcasts',
  );
}

/** 按装备和母星职责裁剪指定文明的当前投影。 */
function inspectCivilization(context: CommandQueryContext): unknown {
  const {commandContext, engine, commandArguments} = context;

  const permits = accountPermissions(commandContext.actor);
  const result = civilization(
    engine,
    singleTarget(commandContext, commandArguments[0]!),
    engine.resolvedKeys!,
    permits.includes('equipment'),
  );
  if (!permits.includes('homeworlds')) {
    result.homeworld = null;
    result.homeVersion = 0;
    result.rejection = '';
  }
  if (!permits.includes('equipment')) {
    result.arms = null;
    result.voyages = [];
  }
  return result;
}

/** 读取文明当前资源与已有来源记录。 */
function queryResources(context: CommandQueryContext): unknown {
  const {commandContext, engine, commandArguments} = context;

  const id = singleTarget(commandContext, commandArguments[0]!);
  return {
    id,
    tech: engine.db.player(id).tech,
    photons: score(engine, id, 'photons'),
    broadcasts: score(engine, id, 'broadcasts'),
    sources: engine.db.all<Record<string, SqlStorageValue>>(
      'SELECT id,kind,title,game_ms FROM event_log WHERE owner=? ORDER BY seq',
      id,
    ),
  };
}

/** 组合阶段、航次、个人处罚及当前UTC效果。 */
function queryRestrictions(context: CommandQueryContext): unknown {
  const {commandContext, engine, commandArguments} = context;

  const id = singleTarget(commandContext, commandArguments[0]!);
  return {
    match: matchProjection(engine),
    flight: engine.db.flight(id),
    penalty: engine.db.one<Record<string, SqlStorageValue>>(
      'SELECT wrong,locked_until FROM attack_controls WHERE player_id=?',
      id,
    ),
    effects: engine.db.all<Record<string, SqlStorageValue>>(
      'SELECT * FROM admin_effects WHERE active=1 AND starts<=? AND ends>? AND (target=? OR target=?)',
      engine.now(),
      engine.now(),
      '@a',
      id,
    ),
  };
}

/** 通过独立历史服务按职责读取文明事实及稳定分页。 */
function queryCivilizationHistory(context: CommandQueryContext): unknown {
  const {commandContext, commandNode, engine, commandArguments} = context;

  const id = singleTarget(commandContext, commandArguments[0]!);
  const kind = commandArguments[2] ?? 'all';
  return civilizationHistory(
    engine,
    commandContext.actor,
    id,
    kind,
    commandNode,
  );
}

/** 分页读取待审核母星登记。 */
function queryPendingHomeworlds(context: CommandQueryContext): unknown {
  const {commandContext, commandNode} = context;

  return page(
    commandContext,
    commandNode,
    'homeworlds',
    '*',
    "status='pending'",
  );
}

/** 读取单一文明母星，未登记时返回空值。 */
function inspectHomeworld(context: CommandQueryContext): unknown {
  const {commandContext, engine, commandArguments} = context;

  return (
    engine.db.home(singleTarget(commandContext, commandArguments[0]!)) ?? null
  );
}

/** 读取配置总容量和已永久发行数量。 */
function queryCodebook(context: CommandQueryContext): unknown {
  const {engine} = context;

  return {
    capacity: 350,
    issued: engine.db.one<{n: number}>('SELECT COUNT(*) n FROM sighting_codes')!
      .n,
  };
}

/** 按稳定名称顺序读取文明标签。 */
function queryTags(context: CommandQueryContext): unknown {
  const {commandContext, engine, commandArguments} = context;

  return engine.db.all<Record<string, SqlStorageValue>>(
    'SELECT tag FROM command_tags WHERE player_id=? ORDER BY tag',
    singleTarget(commandContext, commandArguments[0]!),
  );
}

/** 读取文明的观战限制、淘汰时刻和等待参数。 */
function queryObserver(context: CommandQueryContext): unknown {
  const {commandContext, engine, commandArguments} = context;

  const id = singleTarget(commandContext, commandArguments[0]!);
  return {
    id,
    revoked: engine.db.player(id).observer_revoked,
    flight: engine.db.flight(id).status,
    elimination: engine.db.one<Record<string, SqlStorageValue>>(
      'SELECT utc_ms FROM eliminations WHERE player_id=? AND valid=1',
      id,
    ),
    waitSeconds: engine.db.parameters().observerWaitSeconds,
  };
}

/** 本模块职责内的固定只读路径；共同权限检查仍由查询入口执行。 */
export const playerQueries: ReadonlyMap<string, CommandQueryHandler> = new Map([
  ['roster list', queryRoster],
  ['preflight list', queryPreflight],
  ['player list', queryPlayers],
  ['inspect', inspectCivilization],
  ['player resources', queryResources],
  ['player restrictions', queryRestrictions],
  ['history', queryCivilizationHistory],
  ['homeworld pending', queryPendingHomeworlds],
  ['homeworld inspect', inspectHomeworld],
  ['codebook status', queryCodebook],
  ['tag list', queryTags],
  ['observer status', queryObserver],
]);
