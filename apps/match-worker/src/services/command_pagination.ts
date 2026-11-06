import {integer, scalarText} from '../../../../packages/contracts/src/backend';
import {
  COMMAND_LIMITS,
  instantMs,
  type CommandNode,
} from '../../../../packages/contracts/src/commands';
import {requireThat} from '../storage/store';
import type {CommandContext} from './command_context';
import {requireCommandArgument} from './command_context';

interface PageFilters {
  conditions: string;
  args: SqlStorageValue[];
}
interface BoundedPage {
  count: number;
  items: Array<Record<string, SqlStorageValue>>;
}
/** 以固定字段白名单和稳定游标读取一页，同时限制响应大小。 */
export function page(
  commandContext: CommandContext,
  commandNode: CommandNode,
  table: string,
  columns = '*',
  where = '1=1',
  bindings: SqlStorageValue[] = [],
): unknown {
  const opts = commandNode.options;
  const limit = integer(
    Number(opts.limit ?? COMMAND_LIMITS.page),
    1,
    COMMAND_LIMITS.maxPage,
  );
  const {conditions, args} = pageFilters(
    commandContext,
    opts,
    table,
    where,
    bindings,
  );
  const rows = commandContext.engine.db.all<Record<string, SqlStorageValue>>(
    `SELECT rowid AS _cursor,${columns} FROM ${table} WHERE ${conditions} ORDER BY rowid DESC LIMIT ?`,
    ...args,
    limit + 1,
  );
  const {count, items} = boundedPage(rows, limit);
  if (opts.format) {
    requireCommandArgument(
      ['json', 'text'].includes(opts.format),
      'format为json或text',
    );
  }
  return {
    items,
    nextCursor: rows.length > count ? scalarText(items.at(-1)?._cursor) : null,
    watermark: commandContext.engine.db.match().revision,
  };
}

/** 按游标、字段、时间与检索词顺序构造绑定查询，不接收任意SQL字段。 */
function pageFilters(
  commandContext: CommandContext,
  opts: Record<string, string>,
  table: string,
  where: string,
  bindings: SqlStorageValue[],
): PageFilters {
  const filters: PageFilters = {conditions: `(${where})`, args: [...bindings]};
  if (opts.before) {
    requireCommandArgument(
      /^\d+$/.test(opts.before),
      '游标须为上一页nextCursor',
    );
    filters.conditions += ' AND rowid<?';
    filters.args.push(integer(Number(opts.before)));
  }
  const fields = commandContext.engine.db
    .all<{name: string}>(`PRAGMA table_info(${table})`)
    .map(r => r.name);
  addColumnFilters(filters, opts, table, fields);
  addTimeFilters(filters, opts, fields);
  addSearchFilter(filters, opts, table, fields);
  return filters;
}
/** 只允许表中存在的字段及命令日志/失败事件的明确筛选别名。 */
function addColumnFilters(
  filters: PageFilters,
  opts: Record<string, string>,
  table: string,
  fields: string[],
): void {
  const mappings: Record<string, string> = {
    target: fields.includes('target')
      ? 'target'
      : fields.includes('player_id')
        ? 'player_id'
        : 'owner',
    actor: 'actor',
    kind: 'kind',
    status: 'status',
  };
  for (const optionKey of ['target', 'actor', 'kind', 'status']) {
    if (opts[optionKey]) {
      if (table === 'judge_command_log' && optionKey === 'target') {
        filters.conditions +=
          " AND EXISTS(SELECT 1 FROM json_each(detail,'$.targets') WHERE value=?)";
        filters.args.push(opts[optionKey]);
        continue;
      }
      if (table === 'judge_command_log' && optionKey === 'kind') {
        filters.conditions += ' AND path=?';
        filters.args.push(opts[optionKey]);
        continue;
      }
      if (
        table === 'scheduled_events' &&
        optionKey === 'status' &&
        opts[optionKey] === 'failed'
      ) {
        filters.conditions += " AND status='pending' AND last_error<>''";
        continue;
      }
      const col = mappings[optionKey]!;
      requireCommandArgument(
        fields.includes(col),
        '该列表不支持 --' + optionKey,
      );
      filters.conditions += ` AND ${col}=?`;
      filters.args.push(opts[optionKey]);
    }
  }
}
/** 沿表声明选择时间字段，保持UTC上下界的包含关系。 */
function addTimeFilters(
  filters: PageFilters,
  opts: Record<string, string>,
  fields: string[],
): void {
  const timeCol = fields.find(f =>
    ['created_utc', 'utc_ms', 'committed_utc', 'issued_utc'].includes(f),
  );
  for (const k of ['since', 'until']) {
    if (opts[k]) {
      requireCommandArgument(timeCol, '此列表没有时间范围字段');
      filters.conditions += ` AND ${timeCol}${k === 'since' ? '>=' : '<='}?`;
      filters.args.push(instantMs(opts[k]));
    }
  }
}
/** 只在可检索字段与命令原因中绑定搜索文本。 */
function addSearchFilter(
  filters: PageFilters,
  opts: Record<string, string>,
  table: string,
  fields: string[],
): void {
  if (opts.search) {
    const searchable = fields.filter(f =>
      ['title', 'body', 'path', 'reason', 'nickname', 'name', 'id'].includes(f),
    );
    requireCommandArgument(searchable.length, '此列表不支持搜索');
    filters.conditions += ` AND (${searchable.map(f => `instr(${f},?)>0`).join(' OR ')}${table === 'judge_command_log' ? " OR instr(json_extract(detail,'$.reason'),?)>0" : ''})`;
    filters.args.push(...searchable.map(() => opts.search!));
    if (table === 'judge_command_log') {
      filters.args.push(opts.search);
    }
  }
}
/** 在记录数量及UTF-8字节上限内裁剪结果，单条超限时明确失败。 */
function boundedPage(
  rows: Array<Record<string, SqlStorageValue>>,
  limit: number,
): BoundedPage {
  let count = Math.min(rows.length, limit);
  let items = rows.slice(0, count);
  while (
    new TextEncoder().encode(JSON.stringify(items)).length >
      COMMAND_LIMITS.responseBytes &&
    count > 0
  ) {
    items = rows.slice(0, --count);
  }
  requireThat(
    count > 0 || !rows.length,
    'RESPONSE_TOO_LARGE',
    '单条记录超过1MiB，请使用受保护导出。',
  );
  return {count, items};
}
