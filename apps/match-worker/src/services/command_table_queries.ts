import {permission} from '../storage/store';
import {selectTargets, singleTarget} from './command_context';

import {page} from './command_pagination';
import type {CommandQueryContext} from './command_query_context';
/** 注册查询表及其权限、主键和投影字段；只由固定代码选择。 */
export interface TableQueryConfiguration {
  table: string;
  permission?: string;
  id?: string;
  columns?: string;
}
/** 允许命令分页读取的表和字段白名单，不接受用户提供任意SQL标识符。 */
export const queryTables: Record<string, TableQueryConfiguration> = {
  event: {table: 'scheduled_events', permission: 'system'},
  'event-log': {table: 'event_log'},
  audit: {table: 'audit_logs', permission: 'audit'},
  notice: {table: 'notice_queue', permission: 'notices'},
  attack: {table: 'attacks', permission: 'audit'},
  flight: {
    table: 'sighting_codes',
    columns:
      'id,player_id,voyage,status,issued_utc,activated_utc,activated_game,retired_utc,retired_game,retired_reason',
  },
  codebook: {
    table: 'sighting_codes',
    permission: 'equipment',
    columns: 'id,player_id,voyage,status,issued_utc,retired_utc',
  },
  code: {
    table: 'sighting_codes',
    permission: 'equipment',
    columns: 'id,player_id,voyage,status,issued_utc,retired_utc',
  },
  effect: {table: 'admin_effects'},
  report: {table: 'result_reports', id: 'version'},
  command: {
    table: 'judge_command_log',
    permission: 'audit',
    columns: 'seq,id,actor,request_id,status,path,created_utc,game_ms,detail',
  },
};
/** 在固定表及投影内检查额外权限并分页或读取单条记录。 */
export function queryTable(
  context: CommandQueryContext,
  config: TableQueryConfiguration,
): unknown {
  const {commandContext, commandNode, engine, words, commandArguments} =
    context;

  if (config.permission) {
    permission(commandContext.actor, config.permission);
  }
  if (['list', 'history', 'versions'].includes(words[1]!)) {
    let where = '1=1';
    let bindings: SqlStorageValue[] = [];
    if (words[0] === 'flight' && commandArguments[0]) {
      where = 'player_id=?';
      bindings = [singleTarget(commandContext, commandArguments[0])];
    }
    if (words[0] === 'attack' && commandArguments[0]) {
      const ids = selectTargets(commandContext, commandArguments[0]);
      where = `actor IN (${ids.map(() => '?').join(',')}) OR target IN (${ids.map(() => '?').join(',')})`;
      bindings = [...ids, ...ids];
    }
    return page(
      commandContext,
      commandNode,
      config.table,
      config.columns,
      where,
      bindings,
    );
  }
  const key =
    words[0] === 'report'
      ? (commandArguments[1] ??
        engine.db.one<{v: number}>('SELECT MAX(version) v FROM result_reports')
          ?.v ??
        0)
      : commandArguments[0]!;
  const row = engine.db.one<Record<string, SqlStorageValue>>(
    `SELECT ${config.columns ?? '*'} FROM ${config.table} WHERE ${config.id ?? 'id'}=?`,
    key,
  );
  if (words[0] === 'notice' && row) {
    return {
      ...row,
      actions: engine.db.all<Record<string, SqlStorageValue>>(
        'SELECT * FROM notice_actions WHERE notice_id=? ORDER BY utc_ms,id',
        row.id!,
      ),
    };
  }
  return row ?? null;
}
