import {accountPermissions} from '../storage/store';
import {
  parseJson,
  scalarText,
} from '../../../../packages/contracts/src/backend';
import {
  COMMAND_LIMITS,
  instantMs,
  type CommandNode,
} from '../../../../packages/contracts/src/commands';
import {
  integer,
  object,
  stableJson,
  text,
} from '../../../../packages/contracts/src/backend';
import {permission, requireThat, type Actor} from '../storage/store';
import type {Engine} from './engine';

/** 文明历史查询允许的分类集合，分类可见性仍逐次按角色验证。 */
const HISTORY_KINDS = [
  'all',
  'attack',
  'flight',
  'homeworld',
  'resource',
  'elimination',
  'notice',
  'command',
  'penalty',
  'correction',
] as const;
type Row = Record<string, SqlStorageValue>;
interface Item {
  id: string;
  kind: string;
  source: string;
  position: number;
  utcMs: number;
  gameMs: number | null;
  actor: string | null;
  target: string;
  status: string | null;
  record: Row;
}
interface Cursor {
  query: string;
  ceilings: Record<string, number>;
  before: [number, string, number];
  watermark: number;
}

/** Decode untrusted cursor fields before any SQL waterline or tuple comparison. */
function readHistoryCursor(encoded: string, query: string): Cursor {
  let decoded: unknown;
  try {
    decoded = parseJson(
      new TextDecoder().decode(
        Uint8Array.from(atob(encoded), ch => ch.charCodeAt(0)),
      ),
    );
  } catch {
    // Invalid encoding is rejected by the same cursor check below.
  }
  requireThat(
    decoded && typeof decoded === 'object' && !Array.isArray(decoded),
    'COMMAND_ARGUMENT',
    '历史游标无效，或与当前筛选不匹配。',
    400,
  );
  const fields = object(decoded);
  requireThat(
    fields.query === query &&
      Array.isArray(fields.before) &&
      fields.before.length === 3,
    'COMMAND_ARGUMENT',
    '历史游标无效，或与当前筛选不匹配。',
    400,
  );
  const before: unknown[] = fields.before;
  const ceilings = object(fields.ceilings);
  return {
    query,
    ceilings: Object.fromEntries(
      Object.entries(ceilings).map(([source, ceiling]) => [
        source,
        integer(ceiling, 0),
      ]),
    ),
    before: [
      integer(before[0], 0),
      text(before[1], 128),
      integer(before[2], 1),
    ],
    watermark: integer(fields.watermark, 0),
  };
}

/** Merge independent persisted histories; the cursor fixes each source's first-page waterline. */
export function civilizationHistory(
  engine: Engine,
  actor: Actor,
  id: string,
  kind: string,
  node: CommandNode,
) {
  requireThat(
    HISTORY_KINDS.includes(kind as (typeof HISTORY_KINDS)[number]),
    'COMMAND_ARGUMENT',
    '未知历史类别。',
    400,
  );
  const permits = accountPermissions(actor);
  if (['attack', 'command', 'penalty', 'correction'].includes(kind)) {
    permission(actor, 'audit');
  }
  if (kind === 'notice') {
    permission(actor, 'notices');
  }
  if (kind === 'homeworld') {
    permission(actor, 'homeworlds');
  }
  const opts = node.options;
  const limit = integer(
    Number(opts.limit ?? COMMAND_LIMITS.page),
    1,
    COMMAND_LIMITS.maxPage,
  );
  const query = stableJson({
    id,
    kind,
    options: Object.fromEntries(
      Object.entries(opts).filter(
        ([key]) => !['before', 'limit', 'format'].includes(key),
      ),
    ),
  });
  const cursor = opts.before
    ? readHistoryCursor(opts.before, query)
    : undefined;
  const ceilings: Record<string, number> = {};
  const items: Item[] = [];
  const take = (
    table: string,
    fields: string,
    where: string,
    args: SqlStorageValue[],
    classify: (row: Row) => string,
    utc: string,
    game?: string,
    actorField = 'actor',
  ) => {
    const ceiling =
      cursor?.ceilings[table] ??
      (cursor
        ? 0
        : engine.db.one<{n: number}>(
            `SELECT COALESCE(MAX(rowid),0) n FROM ${table}`,
          )!.n);
    integer(ceiling, 0);
    ceilings[table] = ceiling;
    for (const row of engine.db.all<Record<string, SqlStorageValue>>(
      `SELECT rowid AS position,${fields} FROM ${table} WHERE rowid<=? AND (${where})`,
      ceiling,
      ...args,
    )) {
      const category = classify(row);
      if (!category || (kind !== 'all' && category !== kind)) {
        continue;
      }
      items.push({
        id: scalarText(row.id ?? `${table}:${scalarText(row.position)}`),
        kind: category,
        source: table,
        position: row.position as number,
        utcMs: Number(row[utc] ?? 0),
        gameMs: game && row[game] !== null ? Number(row[game]) : null,
        actor:
          row[actorField] === undefined || row[actorField] === null
            ? null
            : scalarText(row[actorField]),
        target: id,
        status:
          row.status !== undefined
            ? scalarText(row.status)
            : row.valid !== undefined
              ? row.valid
                ? 'valid'
                : 'invalid'
              : null,
        record: row,
      });
    }
  };
  // No cryptographic code indexes, ciphertext, credential hashes or session material enter history.
  take(
    'event_log',
    'id,kind,title,body,audience,owner,civilization_ids,actor,game_ms,utc_ms' +
      (permits.includes('homeworlds') ? ',code' : ''),
    'owner=? OR EXISTS(SELECT 1 FROM json_each(civilization_ids) WHERE value=?)',
    [id, id],
    r =>
      r.kind === 'tech' || r.title === '资源调整'
        ? 'resource'
        : ['singer', 'photon', 'broadcast'].includes(scalarText(r.kind)) ||
            scalarText(r.title).includes('母星')
          ? 'homeworld'
          : 'event',
    'utc_ms',
    'game_ms',
  );
  take(
    'sighting_codes',
    'id,player_id,voyage,status,issued_utc,activated_utc,activated_game,retired_utc,retired_game,retired_reason',
    'player_id=?',
    [id],
    () => 'flight',
    'issued_utc',
    'activated_game',
  );
  take(
    'eliminations',
    'seq,player_id,game_ms,utc_ms,committed_utc,reason,source,group_id,valid',
    'player_id=?',
    [id],
    () => 'elimination',
    'utc_ms',
    'game_ms',
  );
  if (permits.includes('notices')) {
    take(
      'notice_queue',
      '*',
      'target=?',
      [id],
      () => 'notice',
      'copied_utc',
      'game_ms',
      'operator',
    );
    take(
      'notice_actions',
      '*',
      'notice_id IN (SELECT id FROM notice_queue WHERE target=?)',
      [id],
      () => 'notice',
      'utc_ms',
    );
  }
  if (permits.includes('audit')) {
    take(
      'attacks',
      'id,actor,target,code_id,request_id,classification,roll,wrong_index,edge_utc,committed_utc,game_ms,valid,before_json',
      'actor=? OR target=?',
      [id, id],
      row =>
        kind === 'penalty' && row.wrong_index !== null ? 'penalty' : 'attack',
      'committed_utc',
      'game_ms',
    );
    take(
      'attack_corrections',
      '*',
      'attack_id IN (SELECT id FROM attacks WHERE actor=? OR target=?)',
      [id, id],
      () => 'correction',
      'utc_ms',
    );
    const related =
      "target=? OR EXISTS(SELECT 1 FROM json_each(detail,'$.targets') WHERE value=?) OR EXISTS(SELECT 1 FROM json_each(detail,'$.changes') WHERE json_extract(value,'$.target')=?)";
    take(
      'audit_logs',
      '*',
      related,
      [id, id, id],
      r =>
        /penalty|effects/.test(scalarText(r.action))
          ? 'penalty'
          : /correction|invalidate|correct-penalty/.test(scalarText(r.action))
            ? 'correction'
            : /homeworld/.test(scalarText(r.action))
              ? 'homeworld'
              : /resource|photon|tech/.test(scalarText(r.action))
                ? 'resource'
                : 'audit',
      'utc_ms',
      'game_ms',
    );
    take(
      'judge_command_log',
      'seq,id,actor,request_id,status,path,created_utc,game_ms,detail',
      "EXISTS(SELECT 1 FROM json_each(detail,'$.targets') WHERE value=?) OR EXISTS(SELECT 1 FROM json_each(detail,'$.changes') WHERE json_extract(value,'$.target')=?)",
      [id, id],
      () => 'command',
      'created_utc',
      'game_ms',
    );
  }
  const since = opts.since ? instantMs(opts.since) : -Infinity;
  const until = opts.until ? instantMs(opts.until) : Infinity;
  const compare = (a: [number, string, number], b: [number, string, number]) =>
    b[0] - a[0] || b[1].localeCompare(a[1]) || b[2] - a[2];
  const filtered = items
    .filter(
      item =>
        item.utcMs >= since &&
        item.utcMs <= until &&
        (!opts.target || item.target === opts.target) &&
        (!opts.actor || item.actor === opts.actor) &&
        (!opts.kind || item.kind === opts.kind) &&
        (!opts.status || item.status === opts.status) &&
        (!opts.search || stableJson(item).includes(opts.search)) &&
        (!cursor ||
          compare([item.utcMs, item.source, item.position], cursor.before) > 0),
    )
    .sort((a, b) =>
      compare([a.utcMs, a.source, a.position], [b.utcMs, b.source, b.position]),
    );
  let count = Math.min(limit, filtered.length);
  while (
    count &&
    new TextEncoder().encode(JSON.stringify(filtered.slice(0, count))).length >
      COMMAND_LIMITS.responseBytes
  ) {
    count--;
  }
  requireThat(
    count || !filtered.length,
    'RESPONSE_TOO_LARGE',
    '单条历史记录超过1MiB，请使用受保护导出。',
  );
  if (opts.format) {
    requireThat(
      ['json', 'text'].includes(opts.format),
      'COMMAND_ARGUMENT',
      'format为json或text。',
      400,
    );
  }
  const result = filtered.slice(0, count);
  const last = result.at(-1);
  const watermark = cursor?.watermark ?? engine.db.match().revision;
  return {
    items: result,
    nextCursor:
      filtered.length > count && last
        ? btoa(
            Array.from(
              new TextEncoder().encode(
                JSON.stringify({
                  query,
                  ceilings,
                  before: [last.utcMs, last.source, last.position],
                  watermark,
                } satisfies Cursor),
              ),
              byte => String.fromCharCode(byte),
            ).join(''),
          )
        : null,
    watermark,
  };
}
