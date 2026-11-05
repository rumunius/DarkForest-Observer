import type { OperationResult, ManagementPreview, SiteConfig } from '@darkforest/contracts';
import {
  COMMAND_SPECS,
  COMMAND_LIMITS,
  LANGUAGE_VERSION,
  commandSpec,
  parseCommandTree,
  durationMs,
  instantMs,
  type CommandNode,
} from '../../../../packages/contracts/src/commands';
import {
  integer,
  nickname,
  coordinate,
  stableJson,
  strict,
  text,
} from '../../../../packages/contracts/src/backend';
import { Fault, permission, requireThat, type Actor, type Scheduled } from '../storage/store';
import { completed, type Engine, type PreparedCode } from './engine';
import { judgeAction, previewAction, validateParameters } from './judge';
import { civilization, matchProjection } from '../projections/snapshot';
import { autoFinish, destroyHome, eliminate, logEvent, survivors } from './life';
import { restorePlayer } from './player-correction';
import { targets, inRange, score } from './command-targets';
import { correctionTarget, correctAttack } from './attack-correction';
import { dueUtc, settleDue } from '../scheduler/events';
import { TIMES, techSchedule } from '../domain/rules';
import { accountList, updateAccount, prepareCredential } from './accounts';
import { finishRecovery } from './recovery';
import { civilizationHistory } from './civilization-history';
import { managementState } from './management-impact';

type Saved = {
  id: string;
  kind: string;
  actor: string;
  status: string;
  version: number;
  created_utc: number;
  data: string;
};
type Context = {
  e: Engine;
  actor: Actor;
  id: string;
  prepared: PreparedCode[];
  preview: boolean;
  deferred?: boolean;
  self?: string | undefined;
  bindings: Record<string, string[]>;
  scalars: Record<string, string>;
  depth: number;
  work: number;
  changes: ManagementPreview['changes'];
  notes: string[];
  dependencies: Record<string, unknown>;
  initial: Record<string, unknown>;
  reason: string;
  source: string;
  caseId?: string | undefined;
  macroStack: string[];
  resetAccounts: Set<string>;
};
const unquote = (v: string | undefined) =>
  v?.startsWith('"') ? (JSON.parse(v) as string) : (v ?? '');
const value = (v: string | undefined, c: Context) =>
  v && v in c.scalars ? c.scalars[v]! : unquote(v);
function need(condition: unknown, message: string): asserts condition {
  requireThat(condition, 'COMMAND_ARGUMENT', message, 400);
}
function obj(e: Engine, id: string, kind?: string): Saved {
  const row = e.db.one<Saved>('SELECT * FROM command_objects WHERE id=?', id);
  requireThat(
    row && (!kind || row.kind === kind),
    'COMMAND_OBJECT_NOT_FOUND',
    '未找到对应记录：' + id,
    404,
  );
  return row;
}
function save(
  c: Context,
  kind: string,
  data: unknown,
  prefix = kind.toUpperCase(),
  status = 'active',
): string {
  const id = `${prefix}-${c.id}-${c.work}`;
  c.e.db.exec(
    'INSERT INTO command_objects(id,kind,actor,status,created_utc,data) VALUES(?,?,?,?,?,?)',
    id,
    kind,
    c.actor.id,
    status,
    c.e.now(),
    stableJson(data),
  );
  return id;
}
function update(c: Context, row: Saved, data: unknown, status = row.status): void {
  c.e.db.exec(
    'UPDATE command_objects SET data=?,status=?,version=version+1 WHERE id=?',
    stableJson(data),
    status,
    row.id,
  );
}
function capture(e: Engine): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const p of e.db.all<{ id: string }>('SELECT id FROM players ORDER BY id'))
    result['player:' + p.id] = {
      player: e.db.player(p.id),
      flight: e.db.flight(p.id),
      home: e.db.home(p.id) ?? null,
      control: e.db.one('SELECT * FROM attack_controls WHERE player_id=?', p.id),
      elimination:
        e.db.one('SELECT * FROM eliminations WHERE player_id=? AND valid=1', p.id) ?? null,
      tags: e.db.all('SELECT tag FROM command_tags WHERE player_id=? ORDER BY tag', p.id),
    };
  return result;
}
function depend(c: Context, key: string, data: unknown): void {
  if (!(key in c.dependencies)) c.dependencies[key] = data;
}
function select(c: Context, v: string, allowPool = false): string[] {
  if (!allowPool) need(!v.startsWith('@pool'), '本操作不接受候选账号池，请选择正式文明。');
  const set = targets(c.e, v, c.self, c.preview, c.bindings);
  for (const id of set.candidates) depend(c, 'player:' + id, c.initial['player:' + id]);
  if (v.startsWith('@') && v !== '@s') {
    depend(c, 'roster', c.e.db.roster());
    depend(
      c,
      'selector-roster',
      c.e.db.roster().map((id) => c.initial['player:' + id]),
    );
  }
  if (set.random)
    c.notes.push(
      `随机候选：${set.candidates.join('、') || '无'}；均匀无放回抽取${set.count}人，确认时只抽一次。预览示例不是抽签结果。`,
    );
  return set.ids;
}
function one(c: Context, v: string): string {
  const ids = select(c, v);
  need(ids.length === 1, '本操作需要唯一文明；集合请使用execute as。');
  return ids[0]!;
}
function change(c: Context, target: string, before: unknown, after: unknown): void {
  c.changes.push({
    target,
    before: typeof before === 'string' ? before : stableJson(before),
    after: typeof after === 'string' ? after : stableJson(after),
  });
}
function head(c: Context): void {
  permission(c.actor, 'commands');
}
function running(c: Context): void {
  const m = c.e.db.match();
  requireThat(
    m.start_settled !== null && m.phase !== 'ended',
    'MATCH_NOT_RUNNING',
    '请在比赛中执行；赛后使用战报更正。',
  );
}
function forest(c: Context): void {
  running(c);
  requireThat(
    c.e.db.match().phase === 'forest' && c.e.game() < TIMES.apocalypse,
    'FOREST_REQUIRED',
    '该操作仅在65分钟前的第一阶段开放。',
  );
}
function alive(c: Context, id: string): void {
  requireThat(survivors(c.e).includes(id), 'TARGET_NOT_ALIVE', '目标不在正式存活名单中：' + id);
}
function population(c: Context): void {
  depend(c, 'population', survivors(c.e));
}
function eventDependencies(e: Engine): unknown[] {
  return e.db.all(
    'SELECT id,kind,clock,due,priority,status,payload,committed_utc FROM scheduled_events ORDER BY id',
  );
}
function tableDep(c: Context, table: string): void {
  depend(c, 'table:' + table, c.initial['table:' + table] ?? c.e.db.all(`SELECT * FROM ${table}`));
}
function invoke(c: Context, path: string, payload: Record<string, unknown>): OperationResult {
  const e = c.e,
    id = `${c.id}-${c.work}`,
    body = { ...payload, reason: c.reason, expected_revision: e.db.match().revision };
  const p = previewAction(e, c.actor, id, { ...body, path, change: path }).preview!;
  c.changes.push(...p.changes);
  c.notes.push(...p.consequences);
  return judgeAction(e, c.actor, id, path, { ...body, preview_token: p.token }, c.prepared);
}
const parameterKeys: Record<string, string> = {
  'singer-percent': 'singerPercent',
  'wrong-first-lock': 'firstLockSeconds',
  'wrong-second-lock': 'secondLockSeconds',
  'wrong-second-out-percent': 'secondOutPercent',
  'respawn-window': 'respawnSeconds',
  'observer-wait': 'observerWaitSeconds',
  'sighting-min-interval': 'sightingIntervalMs',
  'sighting-per-minute': 'sightingsPerMinute',
};
const settingKeys: Record<string, string> = {
  'activity-name': 'title',
  'activity-description': 'description',
  'qq-group-name': 'qqGroup',
  'qq-group-number': 'qqGroup',
  'judge-contact': 'judgeContact',
  'qq-material-name': 'endgameFile',
};
function template(c: Context, body: string, id?: string): string {
  const phases: Record<string, string> = {
    setup: '赛前准备',
    armed: '等待发码',
    outfitting: '穿戴手环配置',
    start_countdown: '等待开赛',
    forest: '黑暗森林',
    apocalypse: '宇宙末日',
    transfer: '转场',
    hunt: '最后狩猎',
    ended: '比赛结束',
  };
  const allowed: Record<string, string> = {
    id: id ?? '',
    nickname: id ? (c.e.db.player(id).nickname ?? id) : '',
    phase: phases[c.e.db.match().phase] ?? '请查看当前比赛状态',
    game_time: String(c.e.game()),
  };
  return body.replace(/\$\{([^}]+)\}/g, (_m, k: string) => {
    need(k in allowed, '未注册的模板字段：' + k);
    return allowed[k]!;
  });
}
function emit(c: Context, ids: string[], body: string, group = false): void {
  const e = c.e,
    source = `judge:${c.actor.id}:${c.id}:${c.work}`;
  if (
    group &&
    ids.length === e.db.roster().length &&
    ids.every((id) => e.db.roster().includes(id))
  ) {
    const rendered = template(c, body);
    logEvent(e, source, 'notice', '赛事通知', rendered, 'public', [], e.game(), e.now());
    e.notice(source, 'group', '赛事通知', rendered);
  } else
    for (const id of ids) {
      const rendered = template(c, body, id);
      logEvent(
        e,
        `${source}:${id}`,
        'notice',
        '赛事通知',
        rendered,
        'personal',
        [id],
        e.game(),
        e.now(),
        id,
      );
      e.notice(source, id, '赛事通知', rendered);
    }
  change(c, group ? '公告' : '私信', `${ids.length}名收件人`, body);
}
function optionsCheck(n: CommandNode): void {
  const spec = commandSpec(n);
  need(spec, '无法识别命令路径：' + n.words.slice(0, 3).join(' '));
  const list =
    spec.path.endsWith(' list') ||
    ['command history', 'history', 'homeworld pending', 'report versions', 'clock pauses'].includes(
      spec.path,
    );
  const allowed = new Set([
    'reason',
    'source',
    'case',
    ...(list
      ? [
          'limit',
          'before',
          'format',
          'target',
          'actor',
          'kind',
          'status',
          'since',
          'until',
          'search',
        ]
      : []),
    ...(spec.path === 'stats events' ? ['target', 'since', 'until', 'format'] : []),
    ...(spec.path === 'batch run' ? ['mode'] : []),
    ...(spec.path === 'schedule create' ? ['targets', 'late', 'max-lateness', 'after-end'] : []),
    ...(spec.path === 'effect create attack-silence' ? ['end-at'] : []),
  ]);
  for (const key of Object.keys(n.options)) need(allowed.has(key), '该命令不接受 --' + key);
}
function argsCheck(n: CommandNode): void {
  const spec = commandSpec(n)!;
  if (
    [
      'execute',
      'macro define',
      'macro run',
      'schedule create',
      'reveal',
      'case open',
      'case evidence',
    ].includes(spec.path)
  )
    return;
  const tokens = spec.args.split(/\s+/).filter(Boolean),
    a = n.words.slice(spec.path.split(' ').length);
  const min = spec.args.includes('[')
    ? spec.args.slice(0, spec.args.indexOf('[')).trim().split(/\s+/).filter(Boolean).length
    : tokens.length;
  need(a.length >= min && a.length <= tokens.length, `用法：/${spec.path} ${spec.args}`);
  tokens.forEach((t, i) => {
    if (a[i] !== undefined && !/[<>[\]{}]/.test(t)) need(a[i] === t, `参数关键字应为 ${t}`);
  });
  need(!n.block, `/${spec.path} 不接受操作块`);
}
function owner(c: Context, row: Saved): void {
  requireThat(
    row.actor === c.actor.id || JSON.parse(c.actor.permissions).includes('commands'),
    'FORBIDDEN',
    '只能管理本人创建的任务。',
    403,
  );
}
function named(c: Context, kind: string, name: string, version?: number): Saved {
  const rows = c.e.db.all<Saved>(
    "SELECT * FROM command_objects WHERE kind=? AND json_extract(data,'$.name')=? ORDER BY version DESC",
    kind,
    name,
  );
  const row = rows.find((r) => (version ? r.version === version : r.status === 'active'));
  requireThat(row, 'VERSION_NOT_FOUND', '没有对应的有效版本。', 404);
  return row;
}
const queryTables: Record<
  string,
  { table: string; permission?: string; id?: string; columns?: string }
> = {
  event: { table: 'scheduled_events', permission: 'system' },
  'event-log': { table: 'event_log' },
  audit: { table: 'audit_logs', permission: 'audit' },
  notice: { table: 'notice_queue', permission: 'notices' },
  attack: { table: 'attacks', permission: 'audit' },
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
  effect: { table: 'admin_effects' },
  report: { table: 'result_reports', id: 'version' },
  command: {
    table: 'judge_command_log',
    permission: 'audit',
    columns: 'seq,id,actor,request_id,status,path,created_utc,game_ms,detail',
  },
};
function page(
  c: Context,
  n: CommandNode,
  table: string,
  columns = '*',
  where = '1=1',
  bindings: SqlStorageValue[] = [],
): unknown {
  const opts = n.options,
    limit = integer(Number(opts.limit ?? COMMAND_LIMITS.page), 1, COMMAND_LIMITS.maxPage);
  let conditions = `(${where})`;
  const args = [...bindings];
  if (opts.before) {
    need(/^\d+$/.test(opts.before), '游标须为上一页nextCursor');
    conditions += ' AND rowid<?';
    args.push(Number(opts.before));
  }
  const fields = c.e.db.all<{ name: string }>(`PRAGMA table_info(${table})`).map((r) => r.name);
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
  for (const k of ['target', 'actor', 'kind', 'status'])
    if (opts[k]) {
      if (table === 'judge_command_log' && k === 'target') {
        conditions += " AND EXISTS(SELECT 1 FROM json_each(detail,'$.targets') WHERE value=?)";
        args.push(opts[k]!);
        continue;
      }
      if (table === 'judge_command_log' && k === 'kind') {
        conditions += ' AND path=?';
        args.push(opts[k]!);
        continue;
      }
      if (table === 'scheduled_events' && k === 'status' && opts[k] === 'failed') {
        conditions += " AND status='pending' AND last_error<>''";
        continue;
      }
      const col = mappings[k]!;
      need(fields.includes(col), '该列表不支持 --' + k);
      conditions += ` AND ${col}=?`;
      args.push(opts[k]!);
    }
  const timeCol = fields.find((f) =>
    ['created_utc', 'utc_ms', 'committed_utc', 'issued_utc'].includes(f),
  );
  for (const k of ['since', 'until'])
    if (opts[k]) {
      need(timeCol, '此列表没有时间范围字段');
      conditions += ` AND ${timeCol}${k === 'since' ? '>=' : '<='}?`;
      args.push(instantMs(opts[k]!));
    }
  if (opts.search) {
    const searchable = fields.filter((f) =>
      ['title', 'body', 'path', 'reason', 'nickname', 'name', 'id'].includes(f),
    );
    need(searchable.length, '此列表不支持搜索');
    conditions += ` AND (${searchable.map((f) => `instr(${f},?)>0`).join(' OR ')}${table === 'judge_command_log' ? " OR instr(json_extract(detail,'$.reason'),?)>0" : ''})`;
    args.push(...searchable.map(() => opts.search!));
    if (table === 'judge_command_log') args.push(opts.search);
  }
  const rows = c.e.db.all(
    `SELECT rowid AS _cursor,${columns} FROM ${table} WHERE ${conditions} ORDER BY rowid DESC LIMIT ?`,
    ...args,
    limit + 1,
  );
  let count = Math.min(rows.length, limit),
    items = rows.slice(0, count);
  while (
    new TextEncoder().encode(JSON.stringify(items)).length > COMMAND_LIMITS.responseBytes &&
    count > 0
  )
    items = rows.slice(0, --count);
  requireThat(
    count > 0 || !rows.length,
    'RESPONSE_TOO_LARGE',
    '单条记录超过1MiB，请使用受保护导出。',
  );
  if (opts.format) need(['json', 'text'].includes(opts.format), 'format为json或text');
  return {
    items,
    nextCursor: rows.length > count ? String(items.at(-1)?._cursor) : null,
    watermark: c.e.db.match().revision,
  };
}
function statistic(c: Context, n: CommandNode): unknown {
  const a = n.words.slice(2).map((v) => value(v, c)),
    e = c.e;
  if (n.words[1] === 'count') return { count: select(c, a[0]!).length };
  if (n.words[1] === 'sum') {
    need(a[1] === 'of', '用法：stats sum 字段 of 目标');
    return { field: a[0], sum: select(c, a[2]!).reduce((sum, id) => sum + score(e, id, a[0]!), 0) };
  }
  const kind = a[0],
    window = a[2] ? durationMs(a[2]) : null;
  need(!a[1] || a[1] === 'window', '时间窗口须使用window');
  const lower = window === null ? null : Math.max(0, e.game() - window);
  let where =
    lower === null ? '1=1' : lower === 0 ? 'game_ms>=0 AND game_ms<=?' : 'game_ms>? AND game_ms<=?';
  const args: SqlStorageValue[] =
    lower === null ? [] : lower === 0 ? [e.game()] : [lower, e.game()];
  if (n.options.target) {
    const ids = select(c, n.options.target);
    where += ` AND ${kind === 'elimination' ? 'player_id' : 'actor'} IN (${ids.map(() => '?').join(',')})`;
    args.push(...ids);
  }
  const table =
    kind === 'sighting-hit'
      ? 'attacks'
      : kind === 'broadcast'
        ? 'event_log'
        : kind === 'elimination'
          ? 'eliminations'
          : kind === 'homeworld-destroyed'
            ? 'event_log'
            : undefined;
  need(table, '未注册的统计事件类别');
  if (kind === 'sighting-hit') where += " AND classification='hit' AND valid=1";
  if (kind === 'elimination') where += ' AND valid=1';
  if (kind === 'broadcast') where += " AND kind='broadcast'";
  if (kind === 'homeworld-destroyed')
    where +=
      " AND ((kind IN ('singer','photon') AND civilization_ids<>'[]') OR title='裁判母星毁灭')";
  for (const k of ['since', 'until'])
    if (n.options[k]) {
      where += ` AND ${kind === 'elimination' ? 'utc_ms' : kind === 'sighting-hit' ? 'committed_utc' : 'utc_ms'}${k === 'since' ? '>=' : '<='}?`;
      args.push(instantMs(n.options[k]!));
    }
  return {
    kind,
    count: e.db.one<{ n: number }>(`SELECT COUNT(*) n FROM ${table} WHERE ${where}`, ...args)!.n,
    windowMs: window,
  };
}
export function readCommandHistory(
  e: Engine,
  actor: Actor,
  options: Record<string, string> = {},
): unknown {
  permission(actor, 'audit');
  const node: CommandNode = { words: ['command', 'history'], options };
  optionsCheck(node);
  return page(
    context(e, actor, 'history-read', []),
    node,
    'judge_command_log',
    queryTables.command!.columns,
  );
}
function query(c: Context, n: CommandNode): unknown {
  const spec = commandSpec(n)!;
  permission(c.actor, spec.permission);
  argsCheck(n);
  const e = c.e,
    w = n.words,
    a = w.slice(spec.path.split(' ').length).map((v) => value(v, c)),
    path = spec.path;
  if (path === 'help')
    return COMMAND_SPECS.filter((s) => !a[0] || s.path.startsWith(a[0]!))
      .filter((s) => JSON.parse(c.actor.permissions).includes(s.permission))
      .map((s) => ({
        command: `/${s.path} ${s.args}`.trim(),
        description: s.description,
        preview: !s.query && !s.direct,
      }));
  if (path === 'version')
    return { language: LANGUAGE_VERSION, implementation: 1, limits: COMMAND_LIMITS };
  if (path === 'whoami' || path === 'capability list')
    return {
      actor: c.actor.id,
      match: e.db.match().id,
      permissions: JSON.parse(c.actor.permissions),
    };
  if (path === 'selector inspect') {
    const t = targets(e, a[0]!, c.self, true, c.bindings);
    return { candidates: t.candidates, count: t.count, random: t.random, draw: '查询不抽人' };
  }
  if (path === 'clock status' || path === 'match status') return matchProjection(e);
  if (path === 'clock pauses') return page(c, n, 'clock_pauses');
  if (path === 'roster list')
    return e.db.roster().map((id) => ({ id, nickname: e.db.player(id).nickname }));
  if (path === 'preflight list')
    return e.db.roster().map((id) => ({
      id,
      flight: e.db.flight(id),
      verified: e.db.home(id)?.status === 'verified',
    }));
  if (path === 'player list')
    return page(c, n, 'players', 'id,nickname,entry_status,tech,photons,broadcasts');
  if (path === 'inspect') {
    const permits = JSON.parse(c.actor.permissions) as string[];
    const result = civilization(e, one(c, a[0]!), e.resolvedKeys!, permits.includes('equipment'));
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
  if (path === 'player resources') {
    const id = one(c, a[0]!);
    return {
      id,
      tech: e.db.player(id).tech,
      photons: score(e, id, 'photons'),
      broadcasts: score(e, id, 'broadcasts'),
      sources: e.db.all(
        'SELECT id,kind,title,game_ms FROM event_log WHERE owner=? ORDER BY seq',
        id,
      ),
    };
  }
  if (path === 'player restrictions') {
    const id = one(c, a[0]!);
    return {
      match: matchProjection(e),
      flight: e.db.flight(id),
      penalty: e.db.one('SELECT wrong,locked_until FROM attack_controls WHERE player_id=?', id),
      effects: e.db.all(
        'SELECT * FROM admin_effects WHERE active=1 AND starts<=? AND ends>? AND (target=? OR target=?)',
        e.now(),
        e.now(),
        '@a',
        id,
      ),
    };
  }
  if (path === 'history') {
    const id = one(c, a[0]!),
      kind = a[2] ?? 'all';
    return civilizationHistory(e, c.actor, id, kind, n);
  }
  if (path === 'homeworld pending') return page(c, n, 'homeworlds', '*', "status='pending'");
  if (path === 'homeworld inspect') return e.db.home(one(c, a[0]!)) ?? null;
  if (path === 'codebook status')
    return {
      capacity: 350,
      issued: e.db.one<{ n: number }>('SELECT COUNT(*) n FROM sighting_codes')!.n,
    };
  if (path === 'tag list')
    return e.db.all('SELECT tag FROM command_tags WHERE player_id=? ORDER BY tag', one(c, a[0]!));
  if (path === 'observer status') {
    const id = one(c, a[0]!);
    return {
      id,
      revoked: e.db.player(id).observer_revoked,
      flight: e.db.flight(id).status,
      elimination: e.db.one('SELECT utc_ms FROM eliminations WHERE player_id=? AND valid=1', id),
      waitSeconds: e.db.parameters().observerWaitSeconds,
    };
  }
  if (path === 'scheduler health')
    return {
      health: e.db.one('SELECT * FROM scheduler_health'),
      failed: e.db.all(
        "SELECT id,last_error,last_error_utc,attempt_count FROM scheduled_events WHERE last_error<>'' AND status='pending'",
      ),
    };
  if (path === 'hunt status')
    return {
      phase: e.db.match().phase,
      paused: e.db.match().pause_reason,
      finalized: e.db.match().hunt_finalized,
      alive: survivors(e),
    };
  if (path === 'parameter list') return e.db.parameters();
  if (path === 'parameter inspect') {
    need(a[0]! in parameterKeys, '未知参数');
    return {
      key: a[0],
      value: e.db.parameters()[parameterKeys[a[0]!] as keyof ReturnType<typeof e.db.parameters>],
      range: a[0]!.includes('percent')
        ? '0—100'
        : a[0] === 'sighting-min-interval'
          ? '1—60000毫秒'
          : a[0] === 'sighting-per-minute'
            ? '1—120'
            : a[0] === 'observer-wait'
              ? '0—86400秒'
              : '1—86400秒',
    };
  }
  if (path === 'setting list' || path === 'palette list') {
    const site = JSON.parse(e.db.match().site_json) as SiteConfig;
    return path === 'palette list' ? site.colors : site;
  }
  if (path === 'account list' || path === 'account inspect') {
    const accounts = accountList(e, c.actor);
    return path.endsWith('list') ? accounts : (accounts.find((x) => x.id === a[0]) ?? null);
  }
  if (path === 'session list')
    return e.db.all('SELECT account_id,expires,revoked FROM sessions WHERE account_id=?', a[0]!);
  if (path === 'recovery status' || path === 'recovery checklist')
    return {
      state: e.db.match().recovery_state,
      match: matchProjection(e),
      checklist: [
        '核对实际阶段与暂停',
        '核对有效手环配置',
        '核对已传播信息和QQ通知',
        '核对待办与失败事件',
      ],
    };
  if (w[0] === 'stats') return statistic(c, n);
  if (
    ['case', 'schedule', 'macro', 'job', 'export', 'template'].includes(w[0]!) ||
    path === 'hunt draft inspect'
  ) {
    const kind = path === 'hunt draft inspect' ? 'hunt' : w[0]!;
    if (w[1] === 'list') {
      const all =
        ['macro', 'template'].includes(kind) ||
        (JSON.parse(c.actor.permissions) as string[]).includes('commands');
      return page(
        c,
        n,
        'command_objects',
        '*',
        all ? 'kind=?' : 'kind=? AND actor=?',
        all ? [kind] : [kind, c.actor.id],
      );
    }
    if (kind === 'macro' || kind === 'template') {
      const row = named(c, kind, a[0]!, a[2] ? Number(a[2]) : undefined);
      if (path === 'template preview') {
        const id = one(c, a[2]!);
        return template(c, (JSON.parse(row.data) as { body: string }).body, id);
      }
      return { ...row, data: JSON.parse(row.data) };
    }
    const row = obj(e, a[0]!, kind);
    owner(c, row);
    if (path === 'case graph') {
      const data = JSON.parse(row.data) as { evidence: { ref: string | null; note: string }[] };
      const audits = e.db.all<{ id: string; action: string; target: string }>(
        "SELECT id,action,target FROM audit_logs WHERE json_extract(detail,'$.caseId')=? ORDER BY seq",
        row.id,
      );
      const objects = e.db.all<{ id: string; kind: string; status: string }>(
        "SELECT id,kind,status FROM command_objects WHERE json_extract(data,'$.caseId')=? ORDER BY created_utc,id",
        row.id,
      );
      return {
        case: { ...row, data },
        nodes: [
          { id: row.id, kind: 'case' },
          ...data.evidence.filter((x) => x.ref).map((x) => ({ id: x.ref, kind: 'reference' })),
          ...audits.map((x) => ({ ...x, kind: 'audit' })),
          ...objects,
        ],
        edges: [
          ...data.evidence
            .filter((x) => x.ref)
            .map((x) => ({ from: row.id, to: x.ref, relation: 'evidence', note: x.note })),
          ...audits.map((x) => ({ from: row.id, to: x.id, relation: 'operation' })),
          ...objects.map((x) => ({ from: row.id, to: x.id, relation: 'authorization' })),
        ],
      };
    }
    return { ...row, data: JSON.parse(row.data) };
  }
  const config = queryTables[w[0]!];
  if (config) {
    if (config.permission) permission(c.actor, config.permission);
    if (['list', 'history', 'versions'].includes(w[1]!)) {
      let where = '1=1',
        bindings: SqlStorageValue[] = [];
      if (w[0] === 'flight' && a[0]) {
        where = 'player_id=?';
        bindings = [one(c, a[0])];
      }
      if (w[0] === 'attack' && a[0]) {
        const ids = select(c, a[0]);
        where = `actor IN (${ids.map(() => '?').join(',')}) OR target IN (${ids.map(() => '?').join(',')})`;
        bindings = [...ids, ...ids];
      }
      return page(c, n, config.table, config.columns, where, bindings);
    }
    const key =
      w[0] === 'report'
        ? (a[1] ?? e.db.one<{ v: number }>('SELECT MAX(version) v FROM result_reports')?.v ?? 0)
        : a[0]!;
    const row = e.db.one(
      `SELECT ${config.columns ?? '*'} FROM ${config.table} WHERE ${config.id ?? 'id'}=?`,
      key,
    );
    if (w[0] === 'notice' && row)
      return {
        ...row,
        actions: e.db.all(
          'SELECT * FROM notice_actions WHERE notice_id=? ORDER BY utc_ms,id',
          row.id!,
        ),
      };
    return row ?? null;
  }
  throw new Fault(400, 'UNKNOWN_QUERY', '查询路径未注册。');
}

function leaf(c: Context, n: CommandNode): unknown {
  const spec = commandSpec(n)!;
  permission(c.actor, spec.permission);
  argsCheck(n);
  const e = c.e,
    db = e.db,
    m = db.match(),
    path = spec.path,
    a = n.words.slice(path.split(' ').length).map((v) => value(v, c)),
    source = `judge:${c.actor.id}:${c.id}:${c.work}`;
  const chosen = (index = 0, pool = false) => select(c, a[index]!, pool);
  const each = (fn: (id: string) => void, pool = false) => {
    const ids = chosen(0, pool);
    for (const id of ids) {
      if (++c.work > COMMAND_LIMITS.work)
        throw new Fault(
          413,
          'COMMAND_BUDGET',
          '一次提交的操作过多，请缩小范围，或添加 --mode sequential 分步执行。',
        );
      const before = { player: db.player(id), flight: db.flight(id), home: db.home(id) ?? null };
      fn(id);
      change(c, id, before, {
        player: db.player(id),
        flight: db.flight(id),
        home: db.home(id) ?? null,
      });
    }
    if (!ids.length) c.notes.push('0人，无变化。');
    return ids;
  };
  if (path === 'clock pause' || path === 'clock resume')
    return invoke(c, path.endsWith('pause') ? '/judge/pause' : '/judge/resume', {});
  if (path === 'player eliminate' || path === 'hunt eliminate') {
    head(c);
    running(c);
    population(c);
    return each((id) => {
      alive(c, id);
      const reason = a[1] ?? 'judge_intervention';
      need(
        (path === 'hunt eliminate'
          ? ['left_zone', 'sharing_stopped', 'location_violation']
          : ['judge_intervention', 'serious-violation', 'withdrawal']
        ).includes(reason),
        '未知淘汰原因',
      );
      if (path === 'hunt eliminate')
        requireThat(
          m.phase === 'hunt' && m.hunt_finalized !== null && m.paused_at === null,
          'HUNT_NOT_RUNNING',
          '最后狩猎尚未开始。',
        );
      eliminate(e, id, reason, source, e.game(), e.now(), source);
    });
  }
  if (path === 'player restore') {
    head(c);
    running(c);
    population(c);
    tableDep(c, 'sighting_codes');
    return each((id) =>
      restorePlayer(e, id, `${c.id}-${c.work}-${id}`, `${source}:${id}`, c.prepared, true),
    );
  }
  if (path === 'player rename')
    return each((id) => {
      const name = nickname(template(c, a[1]!, id));
      need(!db.one('SELECT id FROM players WHERE nickname=? AND id<>?', name, id), '昵称已被使用');
      db.exec('UPDATE players SET nickname=? WHERE id=?', name, id);
    });
  if (
    ['resource set', 'resource add', 'photon grant', 'photon revoke', 'tech grant'].includes(path)
  ) {
    head(c);
    running(c);
    return each((id) => {
      const p = db.player(id),
        key = path.startsWith('resource') ? a[1]! : 'photons';
      need(['tech-level', 'photons', 'broadcasts'].includes(key), '资源键不正确');
      const before = key === 'tech-level' ? p.tech : score(e, id, key),
        delta = path === 'photon revoke' ? 0 : path.startsWith('resource') ? Number(a[2]) : 1;
      const after = path === 'resource add' ? before + delta : delta;
      integer(after, 0, key === 'broadcasts' ? 2 : 1);
      if (after > before || path === 'tech grant') {
        forest(c);
        alive(c, id);
      }
      if (key === 'tech-level')
        db.exec(
          'UPDATE players SET tech=?,photons=CASE WHEN ?=0 THEN 0 ELSE photons END WHERE id=?',
          after,
          after,
          id,
        );
      else if (key === 'photons')
        db.exec(
          'UPDATE players SET photons=?,tech=CASE WHEN ?=1 THEN 1 ELSE tech END WHERE id=?',
          after,
          after,
          id,
        );
      else db.exec('UPDATE players SET broadcasts=? WHERE id=?', 2 - after, id);
      const resourceName = {
        'tech-level': '文明技术等级',
        photons: '光粒库存',
        broadcasts: '剩余广播次数',
      }[key]!;
      const title = path === 'tech grant' ? '技术爆炸' : '资源调整';
      const message =
        path === 'tech grant'
          ? `${e.identity(id)}获得一枚光粒，可在第一阶段正常出航时发射。`
          : `${e.identity(id)}的${resourceName}由${before}调整为${after}。`;
      logEvent(
        e,
        `${source}:resource:${id}`,
        path === 'tech grant' ? 'tech' : 'notice',
        title,
        message,
        'personal',
        [id],
        e.game(),
        e.now(),
        id,
      );
      e.notice(source, id, title, message);
    });
  }
  if (path.startsWith('penalty ')) {
    head(c);
    running(c);
    return each((id) => {
      const control = db.one('SELECT * FROM attack_controls WHERE player_id=?', id)!;
      if (path === 'penalty wrong-set')
        db.exec(
          'UPDATE attack_controls SET wrong=? WHERE player_id=?',
          integer(Number(a[1]), 0, 3),
          id,
        );
      else {
        const until = path === 'penalty clear' ? 0 : e.now() + durationMs(a[2]!);
        integer(until);
        db.exec('UPDATE attack_controls SET locked_until=? WHERE player_id=?', until, id);
      }
      change(
        c,
        `${id}处罚`,
        control,
        db.one('SELECT * FROM attack_controls WHERE player_id=?', id),
      );
    });
  }
  if (path === 'tag add' || path === 'tag remove')
    return each((id) => {
      const tag = text(a[1], 1024);
      if (path === 'tag add') db.exec('INSERT OR IGNORE INTO command_tags VALUES(?,?)', id, tag);
      else db.exec('DELETE FROM command_tags WHERE player_id=? AND tag=?', id, tag);
      change(c, id + '标签', path.endsWith('add') ? '未添加' : '已添加', tag);
    }, true);
  if (path === 'preflight note')
    return each((id) => {
      save(c, 'preflight', { target: id, note: a[1] });
    }, true);
  if (path === 'observer revoke' || path === 'observer restore') {
    head(c);
    return each((id) => {
      db.exec(
        'UPDATE players SET observer_revoked=? WHERE id=?',
        path.endsWith('revoke') ? 1 : 0,
        id,
      );
    });
  }
  if (path === 'homeworld destroy' || path === 'homeworld restore') {
    head(c);
    forest(c);
    population(c);
    return each((id) => {
      const h = db.home(id);
      requireThat(h?.status === 'verified', 'HOME_NOT_VERIFIED', '目标尚无已审核母星。');
      if (path.endsWith('destroy')) {
        if (destroyHome(e, id, `${source}:${id}`, e.game(), e.now())) {
          logEvent(
            e,
            `${source}:home:${id}`,
            'review',
            '裁判母星毁灭',
            `${e.identity(id)}的母星已被裁判摧毁。`,
            'public',
            [id],
            e.game(),
            e.now(),
            null,
            h.code,
          );
          e.notice(
            `${source}:home`,
            'group',
            '母星毁灭',
            `${e.identity(id)}的母星已被裁判摧毁。坐标${h.code}。`,
          );
        }
      } else {
        db.exec('UPDATE homeworlds SET destroyed_game=NULL WHERE player_id=?', id);
        e.notice(source, id, '母星恢复', '裁判已恢复原登记母星。飞船及已传播信息不会自动恢复。');
      }
    });
  }
  if (path === 'homeworld verify' || path === 'homeworld reject') {
    const id = one(c, a[0]!),
      h = db.home(id);
    need(h, '尚无登记');
    return judgeAction(
      e,
      c.actor,
      `${c.id}-${c.work}`,
      `/judge/homeworld/${id}/verify`,
      {
        request_id: `${c.id}-${c.work}`,
        expected_version: integer(Number(a[2]), 1),
        expected_code: path.endsWith('verify') ? coordinate(a[4]) : h.code,
        decision: path.endsWith('verify') ? 'approve' : 'reject',
        reason: c.reason,
      },
      c.prepared,
    );
  }
  if (path === 'homeworld correct-coordinate') {
    head(c);
    need(m.phase === 'setup', 'T0首次锁定后不能修改母星登记');
    const id = one(c, a[0]!),
      h = db.home(id);
    need(h, '尚无登记');
    db.exec(
      "UPDATE homeworlds SET code=?,version=version+1,status='pending',verified_by=NULL,rejection='' WHERE player_id=?",
      coordinate(a[1]),
      id,
    );
    change(c, id + '母星', h, db.home(id));
    return;
  }
  if (path.startsWith('code ')) {
    head(c);
    tableDep(c, 'sighting_codes');
    return each((id) => {
      const f = db.flight(id);
      if (path === 'code replace-same') {
        need(['BK', 'WH', 'GY', 'YL', 'OR', 'SB', 'PU'].includes(a[1]!), '未知颜色');
        need(f.code_id, '当前没有可替换手环');
        change(c, id + '实物替换', '原同色实物', a[1]);
        return;
      }
      if (path === 'code activate') {
        if (a[1]) need(a[1] === 'issue' && a[2] === f.code_id, '发行编号与当前待激活配置不符');
        if (c.deferred)
          need(
            db.one(
              "SELECT id FROM command_objects WHERE kind='equipment-check' AND json_extract(data,'$.issue')=? AND json_extract(data,'$.target')=?",
              f.code_id,
              id,
            ),
            '定时器不能代替现场佩戴核对，请现场执行code activate',
          );
        else
          save(
            c,
            'equipment-check',
            { target: id, issue: f.code_id, checkedBy: c.actor.id },
            'WEAR',
          );
      }
      invoke(c, '/judge/equipment-correction', {
        target: id,
        mode: path === 'code activate' ? 'activate' : 'reissue',
      });
    });
  }
  if (path === 'attack invalidate' || path === 'attack correct-penalty') {
    head(c);
    tableDep(c, 'attacks');
    tableDep(c, 'sighting_codes');
    const attack = correctionTarget(e, a[0]);
    if (path.endsWith('correct-penalty'))
      need(attack.wrong_index !== null, '这次攻击没有因提交错误目击码而受到处罚。');
    correctAttack(e, `${c.id}-${c.work}`, c.actor.id, attack, c.reason, c.prepared);
    change(c, a[0]!, attack, '已审计更正，保留原抽签和传播事实');
    return;
  }
  if (path.startsWith('effect ')) {
    tableDep(c, 'admin_effects');
    if (path === 'effect create attack-silence') {
      running(c);
      const ids = chosen(),
        global = a[0] === '@a',
        length = a[2] === 'until-revoked' ? null : durationMs(a[2]!);
      const end = n.options['end-at']
        ? instantMs(n.options['end-at']!)
        : length === null
          ? 8640000000000000
          : e.now() + length;
      need(a[1] === 'for' && end > e.now(), '静默期限必须晚于当前时间');
      integer(end);
      for (const id of global ? ['@a'] : ids) {
        const fx = `FX-${c.id}-${c.work++}`;
        db.exec(
          'INSERT INTO admin_effects VALUES(?,?,?,?,?,?,1)',
          fx,
          id,
          e.now(),
          end,
          c.reason,
          c.actor.name,
        );
        change(c, fx, '未生效', `${id} 目击静默至 ${new Date(end).toISOString()}`);
      }
      return;
    }
    const ids = path === 'effect clear' ? chosen() : [];
    const effects = db
      .all<{ id: string; target: string }>(
        'SELECT id,target FROM admin_effects WHERE active=1 AND ends>?',
        e.now(),
      )
      .filter((f) =>
        path === 'effect revoke' ? f.id === a[0] : f.target === '@a' || ids.includes(f.target),
      );
    for (const f of effects) {
      if (f.target === '@a')
        c.notes.push('将撤销这项全场效果。个人处罚和当前阶段的行动限制继续生效。');
      db.exec('UPDATE admin_effects SET active=0 WHERE id=?', f.id);
      change(c, f.id, '生效', '撤销');
    }
    return;
  }
  if (path === 'announce' || path === 'tell') {
    const ids = chosen();
    emit(c, ids, text(a[1], COMMAND_LIMITS.bytes), path === 'announce' && a[0] === '@a');
    return;
  }
  if (path === 'reveal') {
    const ids = chosen();
    let stats: unknown;
    if (n.block) {
      need(
        a[1] === 'run' && n.block.length === 1 && n.block[0]!.words[0] === 'stats',
        'reveal run只接受一条统计查询',
      );
      stats = statistic(c, n.block[0]!);
    } else {
      need(a.length === 2, 'reveal需要目标和统计项');
      if (a[1] === 'alive-homeworlds')
        stats = {
          aliveHomeworlds: db.one<{ n: number }>(
            "SELECT COUNT(*) n FROM homeworlds WHERE status='verified' AND destroyed_game IS NULL AND player_id IN (SELECT player_id FROM roster_members)",
          )!.n,
        };
      else if (a[1] === 'unused-photoids')
        stats = statistic(c, { words: ['stats', 'sum', 'photons', 'of', '@alive'], options: {} });
      else {
        need(a[1] === 'kills-last-10min', '未知快捷统计');
        stats = statistic(c, {
          words: ['stats', 'events', 'sighting-hit', 'window', '10m'],
          options: {},
        });
      }
    }
    emit(c, ids, '赛事统计：' + JSON.stringify(stats), a[0] === '@a');
    return;
  }
  if (path === 'replay') {
    const ids = chosen();
    for (const r of db.all<{ title: string; body: string; code: string | null }>(
      "SELECT title,body,code FROM event_log WHERE audience='public' ORDER BY seq DESC LIMIT ?",
      integer(Number(a[2]), 1, COMMAND_LIMITS.maxPage),
    )) {
      c.work++;
      emit(
        c,
        ids,
        `重播：${r.title}\n${r.body}${r.code ? '\n坐标：' + r.code : ''}`,
        a[0] === '@a',
      );
    }
    return;
  }
  if (path === 'message retract') {
    const row = db.one('SELECT * FROM event_log WHERE id=? AND kind=?', a[0]!, 'notice');
    need(row, '只能撤回管理消息');
    save(c, 'retraction', { message: a[0], reason: c.reason });
    db.exec(
      "UPDATE event_log SET body='[裁判已撤回此消息；已阅读及QQ发送事实保留]' WHERE id=?",
      a[0]!,
    );
    change(c, a[0]!, '可见', '网站标记撤回，已阅读/已发送事实保留');
    return;
  }
  if (path === 'notice mark' || path === 'notice retry') {
    const row = db.one<{ id: string; version: number; status: string }>(
      'SELECT * FROM notice_queue WHERE id=?',
      a[0]!,
    );
    need(row, '通知不存在');
    depend(c, 'notice:' + row.id, row);
    if (path === 'notice retry') {
      need(row.status !== 'sent', '已发送通知不能伪造未发送；请创建更正通知');
      db.exec(
        "UPDATE notice_queue SET status='pending',version=version+1,error='' WHERE id=?",
        row.id,
      );
      return;
    }
    need(['copied', 'sent', 'failed'].includes(a[1]!), '状态为copied/sent/failed');
    return judgeAction(
      e,
      c.actor,
      `${c.id}-${c.work}`,
      `/judge/notices/${row.id}/${a[1] === 'failed' ? 'error' : a[1]}`,
      { request_id: `${c.id}-${c.work}`, expected_version: row.version, reason: a[2] ?? c.reason },
      c.prepared,
    );
  }
  if (path === 'roster add' || path === 'roster remove') {
    head(c);
    tableDep(c, 'roster_members');
    const ids = chosen(0, true),
      current = db.roster();
    return invoke(c, '/judge/roster', {
      members: path.endsWith('add')
        ? [...new Set([...current, ...ids])].sort()
        : current.filter((id) => !ids.includes(id)),
    });
  }
  if (path === 'roster withdraw') {
    head(c);
    tableDep(c, 'roster_members');
    return each((id) => {
      invoke(c, `/judge/roster/${id}/withdraw`, {});
    });
  }
  if (path.startsWith('match ')) return matchTime(c, path, a);
  if (path === 'parameter set') {
    head(c);
    tableDep(c, 'settings');
    need(a[0]! in parameterKeys, '未知参数键');
    const key = parameterKeys[a[0]!]!,
      p = { ...db.parameters() };
    const n = /^[+-]?\d+$/.test(a[1]!)
      ? Number(a[1])
      : durationMs(a[1]!) / (key === 'sightingIntervalMs' ? 1 : 1000);
    (p as unknown as Record<string, number>)[key] = n;
    validateParameters(p);
    return invoke(c, '/judge/parameters', {
      values: p,
      expected_version: db.one<{ version: number }>(
        "SELECT version FROM settings WHERE key='parameters'",
      )!.version,
    });
  }
  if (path === 'setting set' || path === 'palette set') {
    permission(c.actor, 'settings');
    const site = JSON.parse(m.site_json) as SiteConfig,
      before = structuredClone(site);
    depend(c, 'site', site);
    if (path === 'setting set') {
      need(m.phase === 'setup', 'T0后活动设置冻结');
      need(a[0]! in settingKeys, '未知活动设置');
      (site as unknown as Record<string, unknown>)[settingKeys[a[0]!]!] = text(a[1], 1000, 0);
    } else {
      need(a[0]! in site.colors && /^#[\da-f]{6}$/i.test(a[1]!), '颜色ID或色值不正确');
      site.colors[a[0] as keyof typeof site.colors] = a[1]!;
    }
    site.version++;
    db.exec('UPDATE matches SET site_json=?', JSON.stringify(site));
    change(c, '活动显示配置', before, site);
    return;
  }
  if (path === 'template publish') {
    permission(c.actor, 'settings');
    template(c, a[1]!, 'C01');
    const rows = db.all<{ version: number }>(
      "SELECT version FROM command_objects WHERE kind='template' AND json_extract(data,'$.name')=?",
      a[0]!,
    );
    const version = Math.max(0, ...rows.map((r) => r.version)) + 1;
    const id = save(c, 'template', { name: a[0], body: a[1] }, 'TPL');
    db.exec('UPDATE command_objects SET version=? WHERE id=?', version, id);
    change(c, id, '旧模板保留', `发布版本${version}，只用于新消息`);
    return;
  }
  if (path.startsWith('account ')) {
    permission(c.actor, 'system');
    const account = db.one<Actor>('SELECT * FROM accounts WHERE id=?', a[0]!);
    need(account, '账号不存在');
    depend(c, 'account:' + account.id, {
      version: account.version,
      enabled: account.enabled,
      permissions: account.permissions,
    });
    if (path.endsWith('reset-credential')) {
      need(!c.resetAccounts.has(account.id), '同批次不能重复重置同一账号，请拆为两个请求');
      c.resetAccounts.add(account.id);
    }
    const delivery = updateAccount(
      e,
      c.actor,
      {
        target: account.id,
        expected_version: account.version,
        operation: path.endsWith('reset-credential') ? 'reset' : path.split(' ')[1],
        duty: a[1] === 'communication' ? 'communications' : a[1],
      },
      e.commandCredentials[`${c.actor.id}:${account.id}`],
    );
    change(
      c,
      account.id,
      { enabled: account.enabled, permissions: account.permissions },
      '账号已更新，旧会话已撤销',
    );
    return delivery ? { credentialDeliveryId: delivery } : undefined;
  }
  if (path === 'session revoke') {
    permission(c.actor, 'system');
    const account = db.one<Actor>('SELECT * FROM accounts WHERE id=?', a[0]!);
    need(account, '账号不存在');
    need(!JSON.parse(account.permissions).includes('system'), '总裁判账号由部署管理员管理');
    db.exec('UPDATE sessions SET revoked=1 WHERE account_id=?', account.id);
    change(c, account.id, '原会话', '全部撤销');
    return;
  }
  if (path === 'recovery finalize') {
    head(c);
    permission(c.actor, 'system');
    finishRecovery(e);
    change(c, '恢复核对', '待核对', '已完成，维持一般暂停');
    return;
  }
  if (path === 'export create') {
    need(['report', 'audit', 'checkpoint'].includes(a[0]!), '未知导出类型');
    if (a[0] === 'checkpoint')
      need(
        m.phase === 'setup' || m.phase === 'ended' || m.paused_at !== null,
        '检查点导出需要暂停、赛前或赛后',
      );
    const id = save(
      c,
      'export',
      { kind: a[0], download: `/api/judge/export?kind=${a[0]}`, requiresAuthentication: true },
      'EXP',
    );
    change(c, id, '无', '已创建受保护导出入口，下载时重新鉴权和核对');
    return { id, download: `/api/judge/export?kind=${a[0]}` };
  }
  if (path === 'event retry' || path === 'event cancel') {
    head(c);
    tableDep(c, 'scheduled_events');
    const event = db.one<Scheduled>('SELECT * FROM scheduled_events WHERE id=?', a[0]!);
    need(event, '事件不存在');
    if (path.endsWith('cancel')) {
      requireThat(m.paused_at !== null, 'PAUSE_REQUIRED', '请先暂停比赛后核对要取消的事件。');
      need(
        event.status === 'pending' &&
          ['song_visit', 'tech_burst', 'judge_delayed_command', 'judge_command_task'].includes(
            event.kind,
          ),
        '阶段节点和重生超时不能通用取消',
      );
      db.exec("UPDATE scheduled_events SET status='cancelled' WHERE id=?", event.id);
      if (event.kind === 'judge_command_task')
        db.exec("UPDATE command_objects SET status='cancelled' WHERE id=?", event.id);
      change(c, event.id, 'pending', 'cancelled');
      return;
    }
    need(event.status !== 'cancelled', '已取消事件不能重开');
    const utc = dueUtc(e, event);
    need(event.status === 'settled' || (utc !== null && utc <= e.now()), '事件尚未到期');
    if (event.status !== 'settled') {
      settleDue(e);
      change(c, event.id, event.status, 'settled');
    } else c.notes.push('事件已经结算，返回原结算事实，不重新执行。');
    return {
      event: db.one(
        'SELECT id,kind,clock,due,status,committed_utc,attempt_count,last_error FROM scheduled_events WHERE id=?',
        event.id,
      ),
      outcome:
        db.one('SELECT id,kind,title,body,game_ms,utc_ms FROM event_log WHERE id=?', event.id) ??
        null,
    };
  }
  if (path === 'event trigger singer') {
    head(c);
    forest(c);
    population(c);
    const code = coordinate(a[0]),
      home = db.officialHome(code, true);
    if (home) {
      select(c, home.player_id);
      destroyHome(e, home.player_id, source, e.game(), e.now());
    }
    logEvent(
      e,
      source,
      'singer',
      '裁判歌者清理',
      home ? '母星已毁灭' : '未摧毁现存母星',
      'public',
      home ? [home.player_id] : [],
      e.game(),
      e.now(),
      null,
      code,
    );
    e.notice(source, 'group', '歌者清理', `坐标${code}。${home ? '母星已毁灭' : '未摧毁现存母星'}`);
    change(c, code, '未清理', '新增管理清理，不消耗原计划');
    return;
  }
  if (path === 'event trigger tech-burst') {
    head(c);
    forest(c);
    const v = a[0] ?? '@alive[homeworld=alive,tech=0,sort=random,limit=1]';
    return leaf(c, { words: ['tech', 'grant', v], options: {} });
  }
  if (path === 'scheduler rearm') {
    head(c);
    change(c, 'Alarm', '原排程', '提交后按最新版本重排');
    return;
  }
  if (path === 'scheduler settle-due') {
    head(c);
    settleDue(e);
    change(c, '事件积压', '待补结算', '已按顺序补结算');
    return;
  }
  if (path.startsWith('hunt draft ')) {
    head(c);
    need(
      m.phase === 'hunt' && m.pause_reason === 'hunt_review' && m.hunt_finalized === null,
      '当前不在终局核验窗口',
    );
    if (path.endsWith('create')) {
      const id = save(c, 'hunt', { eliminations: [] }, 'HD');
      change(c, id, '无', '空核验草稿');
      return id;
    }
    const row = obj(e, a[0]!, 'hunt'),
      data = JSON.parse(row.data) as { eliminations: { id: string; reason: string }[] };
    const ids = select(c, a[1]!);
    if (path.endsWith('set')) {
      need(['no_share_at_cutoff', 'outside_at_cutoff'].includes(a[2]!), '未知截止原因');
      for (const id of ids) alive(c, id);
    }
    data.eliminations = data.eliminations.filter((p) => !ids.includes(p.id));
    if (path.endsWith('set')) data.eliminations.push(...ids.map((id) => ({ id, reason: a[2]! })));
    update(c, row, data);
    change(c, row.id, '原草稿', data);
    return;
  }
  if (path === 'hunt finalize') {
    head(c);
    population(c);
    const row = obj(e, a[0]!, 'hunt');
    depend(c, 'object:' + row.id, row);
    invoke(c, '/judge/hunt-finalize', JSON.parse(row.data) as Record<string, unknown>);
    update(c, row, JSON.parse(row.data), 'complete');
    return;
  }
  if (path === 'case open') {
    head(c);
    need(
      (a.length === 3 && a[1] === 'note') || (a.length === 5 && a[1] === 'ref' && a[3] === 'note'),
      '用法：case open 类型 [ref ID] note "说明"',
    );
    const id = save(
      c,
      'case',
      { kind: a[0], evidence: [{ ref: a.length === 5 ? a[2] : null, note: a.at(-1) }] },
      'CASE',
    );
    change(c, id, '无', '已建个案');
    return id;
  }
  if (path === 'case evidence' || path === 'case close') {
    head(c);
    const row = obj(e, a[0]!, 'case'),
      data = JSON.parse(row.data) as { evidence: unknown[] };
    if (path.endsWith('evidence')) {
      need(
        a.length === 5 && a[1] === 'ref' && a[3] === 'note',
        '用法：case evidence ID ref 业务ID note "说明"',
      );
      data.evidence.push({ ref: a[2], note: a[4] });
    }
    update(c, row, data, path.endsWith('close') ? 'closed' : row.status);
    change(c, row.id, '原个案', path.endsWith('close') ? '已关闭' : '已追加证据');
    return;
  }
  if (path === 'report correct') {
    head(c);
    need(m.phase === 'ended', '只有完赛后可更正战报');
    tableDep(c, 'result_reports');
    const basis = a[1] ? obj(e, a[1], 'case').id : null;
    const version = db.one<{ v: number }>('SELECT MAX(version) v FROM result_reports')!.v;
    const id = save(
      c,
      'report-draft',
      { basis, reason: c.reason, fromVersion: version, editRoute: '/judge/results' },
      'RPT',
    );
    change(
      c,
      id,
      `正式版本${version}`,
      '更正草稿已建立；请在战报表单选择具体记录和更正值，产生新版本',
    );
    return { id, editRoute: '/judge/results' };
  }
  if (path === 'report publish') {
    head(c);
    need(m.phase === 'ended', '只有完赛后可发布战报');
    const version = Number(a[0]!.replace(/^RPT-/, ''));
    need(db.one('SELECT version FROM result_reports WHERE version=?', version), '战报版本不存在');
    emit(c, db.roster(), `正式战报版本${version}已发布，请查看赛后复盘。`, true);
    return;
  }
  throw new Fault(400, 'UNKNOWN_COMMAND', '命令没有执行处理器：' + path);
}

function matchTime(c: Context, path: string, a: string[]): void {
  head(c);
  const e = c.e,
    db = e.db,
    m = db.match(),
    release = path.endsWith('release'),
    key = release ? 'release_at' : 'started_at',
    old = m[key],
    node = release ? 'code_release' : 'match_start';
  tableDep(c, 'scheduled_events');
  tableDep(c, 'roster_members');
  const time = a.length ? instantMs(a[1]!) : null;
  if (path.includes('postpone') || path.includes('cancel')) {
    need(
      m.start_settled === null &&
        old !== null &&
        e.now() < old &&
        m.phase === (release ? 'armed' : 'start_countdown'),
      '只能修改尚未到达、尚未结算的已锁定节点',
    );
    if (time !== null) need(time > old, '新时刻必须严格晚于原锁定时间');
    const event = db.one<Scheduled>('SELECT * FROM scheduled_events WHERE id=?', node);
    need(event?.status === 'pending', '原节点已结算或不可变更');
    save(c, 'node-history', { node, old, event, newTime: time }, 'NODE');
    if (time === null) {
      db.exec("UPDATE scheduled_events SET status='cancelled' WHERE id=?", node);
      db.exec(`UPDATE matches SET ${key}=NULL,phase=?`, release ? 'armed' : 'outfitting');
    } else {
      db.exec(`UPDATE matches SET ${key}=?`, time);
      db.exec(
        "UPDATE scheduled_events SET due=?,last_error='',last_error_utc=NULL WHERE id=?",
        time,
        node,
      );
    }
  } else {
    need(a[0] === 'at' && time !== null && time > e.now(), '请锁定未来的带时区绝对时间');
    need(
      release
        ? m.phase === 'setup' || (m.phase === 'armed' && m.release_at === null)
        : m.phase === 'outfitting' && m.started_at === null,
      '当前不能锁定此节点',
    );
    const roster = db.roster();
    need(roster.length >= 2, '至少需要两名正式玩家');
    for (const id of roster) {
      select(c, id);
      const f = db.flight(id),
        h = db.home(id);
      need(
        release
          ? f.status === 'staged' &&
              f.departed !== null &&
              f.staged !== null &&
              !f.code_id &&
              h?.status === 'verified'
          : f.status === 'ready' &&
              f.ready !== null &&
              !!f.code_id &&
              !!db.one(
                "SELECT id FROM sighting_codes WHERE id=? AND player_id=? AND status='reserved'",
                f.code_id,
                id,
              ),
        '正式玩家尚未完成准备：' + id,
      );
    }
    if (release)
      need(
        db.one<{ n: number }>('SELECT COUNT(*) n FROM sighting_codes')!.n + roster.length <= 350,
        '首航码容量不足',
      );
    if (release)
      db.exec("INSERT OR IGNORE INTO settings(key,value) VALUES('parameters_frozen','true')");
    db.exec(`UPDATE matches SET ${key}=?,phase=?`, time, release ? 'armed' : 'start_countdown');
    const previous = db.one<Scheduled>('SELECT * FROM scheduled_events WHERE id=?', node);
    if (previous) {
      need(previous.status === 'cancelled', '原节点仍有效');
      save(c, 'node-history', { event: previous }, 'NODE');
      db.exec(
        "UPDATE scheduled_events SET due=?,status='pending',committed_utc=NULL,last_error='',last_error_utc=NULL WHERE id=?",
        time,
        node,
      );
    } else e.schedule(node, node, 'utc', time, 0);
    if (!release) {
      const oldPlan = db.one<Saved>(
        "SELECT * FROM command_objects WHERE kind='start-plan' AND status='active' ORDER BY created_utc DESC LIMIT 1",
      );
      const existing = oldPlan
        ? (JSON.parse(oldPlan.data) as { roster: string[]; times: number[] })
        : null;
      let times: number[];
      if (existing && stableJson(existing.roster) === stableJson(roster)) times = existing.times;
      else if (
        !oldPlan &&
        db.one("SELECT id FROM scheduled_events WHERE kind='tech_burst' AND id LIKE 'tech:%'")
      ) {
        times = db
          .all<{ due: number }>(
            "SELECT due FROM scheduled_events WHERE kind='tech_burst' AND id LIKE 'tech:%' ORDER BY due",
          )
          .map((r) => r.due);
      } else {
        times = c.preview ? techSchedulePreview(roster.length) : techSchedule(roster.length);
        if (oldPlan)
          db.exec("UPDATE command_objects SET status='superseded' WHERE id=?", oldPlan.id);
        db.exec(
          "UPDATE scheduled_events SET status='cancelled' WHERE kind='tech_burst' AND status='pending' AND (id LIKE 'tech:%' OR id LIKE 'plan-tech:%')",
        );
      }
      const planId =
        oldPlan && existing && stableJson(existing.roster) === stableJson(roster)
          ? oldPlan.id
          : save(c, 'start-plan', { roster, times }, 'START');
      for (const [kind, due] of [
        ['apocalypse', TIMES.apocalypse],
        ['transfer_start', TIMES.transfer],
        ['hunt_cutoff', TIMES.cutoff],
        ['regulation_end', TIMES.end],
      ] as const)
        if (!db.one('SELECT id FROM scheduled_events WHERE id=?', kind))
          e.schedule(kind, kind, 'game', due, 0);
      if (!existing || stableJson(existing.roster) !== stableJson(roster)) {
        if (
          !db.one(
            "SELECT id FROM scheduled_events WHERE kind='tech_burst' AND status='pending' AND id LIKE 'tech:%'",
          )
        )
          for (const [index, due] of times.entries())
            e.schedule(`plan-tech:${planId}:${index}`, 'tech_burst', 'game', due, 2);
      }
      c.notes.push(
        `技术爆炸${times.length}次；相同名单重新锁定保留原计划，名单变化生成新版本并保全旧版。UTC管理任务不会自动顺延。`,
      );
    }
  }
  const title = release ? '统一发码时间' : '统一开赛时间';
  const pending = db.all<{ id: string }>(
    "SELECT id FROM notice_queue WHERE title=? AND status<>'sent'",
    title,
  );
  for (const row of pending)
    db.exec(
      "UPDATE notice_queue SET error='安排已被替代，请使用最新通知',status='error',version=version+1 WHERE id=?",
      row.id,
    );
  e.notice(
    `judge:${c.id}:${c.work}`,
    'group',
    title,
    time === null
      ? `${title}已撤销，等待重新锁定。请以最新通知为准。`
      : `${title}：${new Date(time).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}（北京时间）。请以最新通知为准。`,
  );
  change(
    c,
    title,
    old === null ? '未锁定' : new Date(old).toISOString(),
    time === null ? '已撤销，冻结仍有效' : new Date(time).toISOString(),
  );
  c.notes.push('节点到达后不可修改；已复制和已发送事实保留，请人工更正QQ公告。提交后重排Alarm。');
}
function techSchedulePreview(n: number): number[] {
  const count = Math.min(Math.max(1, Math.round(n / 3)), Math.floor((n - 1) / 2));
  return Array.from(
    { length: count },
    (_, i) => 480000 + (i + 1) * Math.floor(2820000 / (count + 1)),
  );
}

function condition(c: Context, words: string[]): boolean {
  let i = 0;
  const take = () => {
    need(i < words.length, '条件不完整');
    return value(words[i++]!, c);
  };
  const single = (v: string) => one(c, v);
  const predicate = (): boolean => {
    const kind = take(),
      e = c.e;
    if (kind === 'entity') return select(c, take()).length > 0;
    if (kind === 'match') {
      const key = take(),
        v = take(),
        m = e.db.match();
      if (key === 'phase') return m.phase === v;
      if (key === 'paused') {
        need(['true', 'false'].includes(v), 'paused为布尔值');
        return (m.paused_at !== null) === (v === 'true');
      }
      need(key === 'alive', '未知match条件');
      population(c);
      return inRange(survivors(e).length, v);
    }
    if (kind === 'player') {
      const id = single(take()),
        field = take(),
        v = take();
      if (field === 'status') return e.db.flight(id).status === v;
      need(field === 'homeworld', '未知player条件');
      const h = e.db.home(id);
      return v === 'pending'
        ? h?.status === 'pending'
        : h?.status === 'verified' &&
            (v === 'alive' ? h.destroyed_game === null : h.destroyed_game !== null);
    }
    if (kind === 'score') {
      const id = single(take()),
        key = take();
      need(take() === 'matches', 'score条件缺少matches');
      return inRange(score(e, id, key), take());
    }
    if (kind === 'tag') {
      const id = single(take()),
        tag = take();
      return !!e.db.one('SELECT tag FROM command_tags WHERE player_id=? AND tag=?', id, tag);
    }
    if (kind === 'effect') {
      const id = take();
      need(take() === 'active', 'effect条件缺少active');
      const row = e.db.one<{ active: number; starts: number; ends: number }>(
        'SELECT active,starts,ends FROM admin_effects WHERE id=?',
        id,
      );
      depend(c, 'effect:' + id, row ?? null);
      return !!row?.active && row.starts <= e.now() && e.now() < row.ends;
    }
    if (kind === 'event') {
      const id = take();
      need(take() === 'status', 'event条件缺少status');
      const v = take(),
        row = e.db.one<Scheduled>('SELECT * FROM scheduled_events WHERE id=?', id);
      depend(c, 'event:' + id, row ?? null);
      return (row?.status === 'pending' && row.last_error ? 'failed' : row?.status) === v;
    }
    throw new Fault(400, 'CONDITION_SYNTAX', '未知条件：' + kind);
  };
  const not = (): boolean => {
    if (words[i] === 'not') {
      i++;
      return !not();
    }
    if (words[i] === '(') {
      i++;
      const v = or();
      need(words[i++] === ')', '条件缺少右括号');
      return v;
    }
    return predicate();
  };
  const and = (): boolean => {
    let v = not();
    while (words[i] === 'and') {
      i++;
      const rhs = not();
      v = v && rhs;
    }
    return v;
  };
  const or = (): boolean => {
    let v = and();
    while (words[i] === 'or') {
      i++;
      const rhs = and();
      v = v || rhs;
    }
    return v;
  };
  const result = or();
  need(i === words.length, '条件含多余参数');
  return result;
}
type MacroData = { name: string; params: { name: string; type: string }[]; block: CommandNode[] };
function pin(c: Context, n: CommandNode, stack: string[] = []): void {
  const spec = commandSpec(n);
  need(spec, '未注册的命令');
  optionsCheck(n);
  permission(c.actor, spec.permission);
  need(
    !['plan', 'confirm', 'request'].includes(n.words[0]!) && !spec.query,
    '授权控制及查询不能嵌入操作块',
  );
  if (spec.path === 'macro run') {
    const name = unquote(n.words[2]),
      versionIndex = n.words.indexOf('version'),
      row = named(
        c,
        'macro',
        name,
        versionIndex >= 0 ? Number(n.words[versionIndex + 1]) : undefined,
      );
    need(!stack.includes(name), '宏不能直接或间接递归');
    const data = JSON.parse(row.data) as MacroData;
    if (versionIndex < 0) n.words.push('version', String(row.version));
    for (const node of data.block) pin(c, node, [...stack, name]);
  }
  for (const child of n.block ?? []) {
    if (spec.path === 'reveal' && child.words[0] === 'stats') {
      permission(c.actor, 'overview');
      optionsCheck(child);
      argsCheck(child);
    } else pin(c, child, stack);
  }
}
function run(c: Context, n: CommandNode): unknown {
  need(++c.depth <= COMMAND_LIMITS.depth, '执行嵌套超过32层');
  const prior = {
    reason: c.reason,
    source: c.source,
    caseId: c.caseId,
    self: c.self,
    bindings: c.bindings,
    scalars: c.scalars,
  };
  try {
    if (++c.work > COMMAND_LIMITS.work)
      throw new Fault(413, 'COMMAND_BUDGET', '展开操作超出工作预算，请缩小批次。');
    optionsCheck(n);
    const spec = commandSpec(n)!;
    permission(c.actor, spec.permission);
    c.reason = n.options.reason ?? c.reason;
    c.source = n.options.source ?? c.source;
    c.caseId = n.options.case ?? c.caseId;
    if (c.caseId) {
      const record = obj(c.e, c.caseId, 'case');
      depend(c, 'object:' + record.id, record);
    }
    if (spec.query) return query(c, n);
    if (spec.path === 'batch run') {
      need(n.words.length === 2 && n.block?.length, '用法：batch run { 操作; ... }');
      if (n.options.mode)
        need(['atomic', 'sequential'].includes(n.options.mode), 'mode须为atomic或sequential');
      if (n.options.mode === 'sequential') return createJob(c, n.block);
      const results = [];
      for (const child of n.block) results.push(run(c, child));
      return results;
    }
    if (spec.path === 'execute') {
      need(n.block?.length && n.words.at(-1) === 'run', 'execute需要run操作块');
      let index = 1,
        ids: (string | undefined)[] = [c.self];
      if (n.words[index] === 'as') {
        ids = select(c, n.words[index + 1]!);
        index += 2;
      }
      const steps: { unless: boolean; words: string[] }[] = [];
      while (index < n.words.length - 1) {
        const kind = n.words[index++];
        need(kind === 'if' || kind === 'unless', 'execute需要as/if/unless/run');
        const start = index;
        let depth = 0;
        while (index < n.words.length - 1) {
          const w = n.words[index]!;
          if (w === '(') depth++;
          if (w === ')') depth--;
          if (!depth && ['if', 'unless'].includes(w)) break;
          index++;
        }
        steps.push({ unless: kind === 'unless', words: n.words.slice(start, index) });
      }
      const out = [];
      for (const id of ids) {
        c.self = id;
        let enabled = true;
        for (const step of steps) {
          const matches = condition(c, step.words);
          enabled = enabled && (step.unless ? !matches : matches);
        }
        if (enabled) {
          for (const child of n.block) out.push(run(c, child));
        } else c.notes.push(`条件为假：${id ?? '全局'}，无操作。`);
      }
      return out;
    }
    if (spec.path === 'macro define') {
      head(c);
      need(n.block?.length && n.words.at(-1) === 'run', '宏定义需要run操作块');
      const name = value(n.words[2], c);
      text(name, 200);
      const params: { name: string; type: string }[] = [];
      if (n.words.length > 4) {
        need(
          n.words[3] === 'params' && n.words[4] === '(' && n.words.at(-2) === ')',
          '宏参数须使用params (...)',
        );
        const declarations = n.words.slice(5, -2).join('').split(',');
        for (const decl of declarations) {
          const match = /^([A-Za-z][A-Za-z0-9_]*):(target|int|duration|text|bool)$/.exec(decl);
          need(
            match && !params.some((p) => p.name === match[1]),
            '宏参数类型、名称或重复声明不正确',
          );
          params.push({ name: match[1]!, type: match[2]! });
        }
      }
      const block = structuredClone(n.block);
      for (const node of block) {
        need(!(node.words[0] === 'macro' && unquote(node.words[2]) === name), '宏不能递归');
        pin(c, node, [name]);
      }
      const versions = c.e.db.all<{ version: number }>(
          "SELECT version FROM command_objects WHERE kind='macro' AND json_extract(data,'$.name')=?",
          name,
        ),
        version = Math.max(0, ...versions.map((v) => v.version)) + 1;
      const id = save(c, 'macro', { name, params, block }, 'MAC');
      c.e.db.exec('UPDATE command_objects SET version=? WHERE id=?', version, id);
      change(c, id, '原版本保留', `宏「${name}」版本${version}已保存，尚未执行`);
      return { id, version };
    }
    if (spec.path === 'macro run') {
      const name = value(n.words[2], c),
        v = n.words.indexOf('version'),
        row = named(c, 'macro', name, v >= 0 ? Number(n.words[v + 1]) : undefined),
        data = JSON.parse(row.data) as MacroData;
      depend(c, 'object:' + row.id, row);
      need(!c.macroStack.includes(row.id), '宏不能递归');
      const rest = n.words.slice(3, v >= 0 ? v : undefined),
        args: string[] = [];
      if (rest.length) {
        need(rest[0] === '(' && rest.at(-1) === ')', '宏参数须在括号内');
        let current: string[] = [];
        for (const word of rest.slice(1, -1)) {
          if (word === ',') {
            args.push(current.join(''));
            current = [];
          } else current.push(word);
        }
        if (current.length) args.push(current.join(''));
      }
      need(args.length === data.params.length, '宏实参数量与声明不一致');
      c.bindings = { ...c.bindings };
      c.scalars = { ...c.scalars };
      for (const [i, p] of data.params.entries()) {
        const arg = value(args[i], c),
          key = '$' + p.name;
        if (p.type === 'target') c.bindings[key] = select(c, arg);
        else {
          if (p.type === 'int') integer(Number(arg), Number.MIN_SAFE_INTEGER);
          if (p.type === 'duration') durationMs(arg);
          if (p.type === 'bool') need(['true', 'false'].includes(arg), '宏布尔参数须为true/false');
          c.scalars[key] = arg;
        }
      }
      c.macroStack.push(row.id);
      try {
        return data.block.map((child) => run(c, child));
      } finally {
        c.macroStack.pop();
      }
    }
    if (spec.path === 'macro retire') {
      head(c);
      argsCheck(n);
      const row = named(c, 'macro', value(n.words[2], c), integer(Number(n.words[4]), 1));
      update(c, row, JSON.parse(row.data), 'retired');
      change(c, row.id, 'active', 'retired');
      return;
    }
    if (spec.path === 'schedule create') return createSchedule(c, n);
    if (spec.path === 'schedule cancel' || spec.path === 'job cancel') {
      argsCheck(n);
      const row = obj(c.e, value(n.words[2], c), spec.path.startsWith('job') ? 'job' : 'schedule');
      owner(c, row);
      if (['complete', 'cancelled'].includes(row.status)) return JSON.parse(row.data);
      update(c, row, JSON.parse(row.data), 'cancelled');
      c.e.db.exec(
        "UPDATE scheduled_events SET status='cancelled' WHERE (id=? OR json_extract(payload,'$.job')=?) AND status='pending'",
        row.id,
        row.id,
      );
      change(c, row.id, row.status, 'cancelled；已提交步骤不回滚');
      return;
    }
    const offset = c.changes.length,
      result = leaf(c, n),
      changes = c.changes.slice(offset);
    const ids = [...new Set(changes.map((p) => p.target).filter((id) => /^C\d{2,3}$/.test(id)))];
    c.e.audit(
      c.actor.id,
      'command:' + spec.path,
      ids.length === 1 ? ids[0]! : c.e.db.match().id,
      c.reason,
      { requestId: c.id, source: c.source, caseId: c.caseId ?? null, status: 'executed', changes },
    );
    if (changes.length)
      logEvent(
        c.e,
        `command:${c.actor.id}:${c.id}:${c.work}`,
        'review',
        /^(resource|photon|tech) /.test(spec.path) ? '资源调整' : '裁判指令',
        c.reason,
        'global',
        ids,
        c.e.game(),
        c.e.now(),
      );
    return result;
  } finally {
    Object.assign(c, prior);
    c.depth--;
  }
}

type TaskData = {
  node: CommandNode;
  due: number;
  clock: 'utc' | 'game';
  late: 'run' | 'skip' | 'review';
  maxLateness: number | null;
  afterEnd: 'keep' | 'cancel';
  snapshot: Record<string, string[]>;
  reason: string;
  source: string;
  caseId?: string | undefined;
  results?: unknown;
  error?: string;
  job?: string;
};
function macroBody(e: Engine, n: CommandNode): CommandNode[] | undefined {
  if (commandSpec(n)?.path !== 'macro run') return;
  const v = n.words.indexOf('version');
  const row = e.db.one<{ data: string }>(
    "SELECT data FROM command_objects WHERE kind='macro' AND json_extract(data,'$.name')=? AND version=?",
    unquote(n.words[2]),
    Number(n.words[v + 1]),
  );
  return row ? (JSON.parse(row.data) as MacroData).block : undefined;
}
function isMessage(e: Engine, n: CommandNode): boolean {
  if (['announce', 'tell', 'notice', 'reveal', 'replay'].includes(n.words[0]!)) return true;
  const block =
    macroBody(e, n) ?? (['batch', 'execute'].includes(n.words[0]!) ? n.block : undefined);
  if (block) return block.every((child) => isMessage(e, child));
  return false;
}
function collectSnapshot(c: Context, n: CommandNode, result: Record<string, string[]>): void {
  for (const w of n.words)
    if (/^@(a|alive|dead|random|pool)(\[|$)/.test(w))
      result[w] = targets(c.e, w, c.self, true, c.bindings).candidates;
  for (const child of n.block ?? []) collectSnapshot(c, child, result);
  for (const child of macroBody(c.e, n) ?? []) collectSnapshot(c, child, result);
}
function createSchedule(c: Context, n: CommandNode): unknown {
  need(
    (n.block?.length && n.words.length === 7 && n.words[5] === 'run') ||
      (n.block?.length && n.words.length === 6 && n.words[5] === 'run'),
    '用法：schedule create utc|game in|at 时间 run { 操作 }',
  );
  const clock = n.words[2],
    mode = n.words[3],
    raw = value(n.words[4], c);
  need(clock === 'utc' || clock === 'game', '时基为utc或game');
  need(mode === 'at' || mode === 'in', '时间模式为at或in');
  const block = structuredClone(n.block!);
  for (const node of block) pin(c, node);
  let due: number;
  if (mode === 'in') due = (clock === 'utc' ? c.e.now() : c.e.game()) + durationMs(raw);
  else if (clock === 'utc') due = instantMs(raw);
  else {
    const m = /^g(\d+):([0-5]\d)(?:\.(\d{3}))?$/.exec(raw);
    need(m, '游戏时刻须为g分:秒[.毫秒]');
    due = Number(m[1]) * 60000 + Number(m[2]) * 1000 + Number(m[3] ?? 0);
  }
  integer(due);
  const node: CommandNode = { words: ['batch', 'run'], block, options: {} };
  const message = isMessage(c.e, node),
    late = n.options.late ?? (message ? 'run' : 'review'),
    afterEnd = n.options['after-end'] ?? (message ? 'keep' : 'cancel');
  need(['run', 'skip', 'review'].includes(late), 'late须为run/skip/review');
  need(['keep', 'cancel'].includes(afterEnd), 'after-end须为keep/cancel');
  need(afterEnd !== 'keep' || message, '混合或战局任务不能在赛后执行');
  need(
    !n.options.targets || ['live', 'snapshot'].includes(n.options.targets),
    'targets为live或snapshot',
  );
  const snapshot: Record<string, string[]> = {};
  if (n.options.targets === 'snapshot') collectSnapshot(c, node, snapshot);
  const data: TaskData = {
    node,
    due,
    clock,
    late: late as TaskData['late'],
    maxLateness: n.options['max-lateness'] ? durationMs(n.options['max-lateness']!) : null,
    afterEnd: afterEnd as TaskData['afterEnd'],
    snapshot,
    reason: c.reason,
    source: c.source,
    caseId: c.caseId,
  };
  const id = save(c, 'schedule', data, 'SCH', 'pending');
  c.e.schedule(id, 'judge_command_task', clock, due, 3, { id });
  change(
    c,
    id,
    '无定时任务',
    `${clock === 'utc' ? new Date(due).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' }) + ' 北京时间' : `有效比赛${due}毫秒`}；目标${n.options.targets ?? 'live'}；迟到${late}；赛后${afterEnd}`,
  );
  c.notes.push(
    '到期时重新检查创建者权限、比赛暂停情况、现场核对记录和当前操作条件。随机目标在执行时抽取；淘汰或恢复文明可能影响提前完赛。',
  );
  return { id };
}
type JobData = {
  steps: CommandNode[];
  next: number;
  results: unknown[];
  reason: string;
  error?: string;
};
function createJob(c: Context, steps: CommandNode[]): unknown {
  const pinned = structuredClone(steps);
  for (const node of pinned) pin(c, node);
  const id = save(
    c,
    'job',
    { steps: pinned, next: 0, results: [], reason: c.reason } satisfies JobData,
    'JOB',
    'pending',
  );
  c.e.schedule(`${id}:0`, 'judge_command_job', 'utc', c.e.now(), 3, { job: id, index: 0 });
  change(
    c,
    id,
    '无作业',
    `${steps.length}步独立提交；失败停止，已提交步骤不回滚，每步检查提前完赛。`,
  );
  return { id };
}
function context(
  e: Engine,
  actor: Actor,
  id: string,
  prepared: PreparedCode[],
  preview = false,
): Context {
  const initial = capture(e),
    m = e.db.match();
  for (const table of [
    'settings',
    'sighting_codes',
    'attacks',
    'scheduled_events',
    'roster_members',
    'admin_effects',
    'result_reports',
  ])
    initial['table:' + table] =
      table === 'scheduled_events' ? eventDependencies(e) : e.db.all(`SELECT * FROM ${table}`);
  return {
    e,
    actor,
    id,
    prepared,
    preview,
    bindings: {},
    scalars: {},
    depth: 0,
    work: 0,
    changes: [],
    notes: [],
    dependencies: {
      match: {
        phase: m.phase,
        release_at: m.release_at,
        started_at: m.started_at,
        start_settled: m.start_settled,
        paused_at: m.paused_at,
        pause_reason: m.pause_reason,
        hunt_finalized: m.hunt_finalized,
        recovery_state: m.recovery_state,
      },
      permissions: actor.permissions,
    },
    initial,
    reason: '裁判主动干预',
    source: 'judge_intervention',
    macroStack: [],
    resetAccounts: new Set(),
  };
}
function simulate(
  e: Engine,
  actor: Actor,
  id: string,
  node: CommandNode,
  prepared: PreparedCode[],
  reason: string,
): Context {
  const c = context(e, actor, id, prepared, true),
    rollback = new Error('COMMAND_PREVIEW_ROLLBACK');
  c.reason = reason;
  const previous = e.commandBatch;
  e.commandBatch = true;
  try {
    e.db.tx(() => {
      run(c, node);
      const count = survivors(e).length;
      if (e.db.match().start_settled !== null && count <= 1)
        c.notes.push(`整批结束后存活${count}人，将提前完赛。`);
      throw rollback;
    });
  } catch (error) {
    if (error !== rollback) throw error;
  } finally {
    e.commandBatch = previous;
  }
  return c;
}
function currentDependency(e: Engine, key: string, initial: Record<string, unknown>): unknown {
  if (key in initial) return initial[key];
  if (key === 'roster') return e.db.roster();
  if (key === 'population') return survivors(e);
  if (key === 'site') return JSON.parse(e.db.match().site_json);
  if (key.startsWith('object:'))
    return e.db.one('SELECT * FROM command_objects WHERE id=?', key.slice(7));
  if (key.startsWith('notice:'))
    return e.db.one('SELECT * FROM notice_queue WHERE id=?', key.slice(7));
  if (key.startsWith('account:'))
    return e.db.one('SELECT version,enabled,permissions FROM accounts WHERE id=?', key.slice(8));
  if (key.startsWith('effect:'))
    return (
      e.db.one('SELECT active,starts,ends FROM admin_effects WHERE id=?', key.slice(7)) ?? null
    );
  if (key.startsWith('event:'))
    return e.db.one('SELECT * FROM scheduled_events WHERE id=?', key.slice(6)) ?? null;
  if (key === 'selector-roster') return e.db.roster().map((id) => initial['player:' + id]);
  return undefined;
}
type PlanData = {
  node: CommandNode;
  reason: string;
  dependencies: Record<string, unknown>;
  preview: ManagementPreview;
  result?: OperationResult;
};
function commandState(e: Engine): Record<string, unknown> {
  return {
    ...managementState(e),
    objects: e.db.all(
      'SELECT id,kind,actor,status,version,created_utc FROM command_objects ORDER BY id',
    ),
    tags: e.db.all('SELECT * FROM command_tags ORDER BY player_id,tag'),
  };
}
function actualTargets(changes: ManagementPreview['changes']): string[] {
  return [
    ...new Set(
      changes
        .map((change) => (/^C\d{2,3}$/.test(change.target) ? change.target : null))
        .filter((id): id is string => id !== null),
    ),
  ];
}
export const parseCommand = parseCommandTree;
export function commandAction(
  e: Engine,
  actor: Actor,
  id: string,
  path: string,
  raw: Record<string, unknown>,
  prepared: PreparedCode[],
  keys: Awaited<ReturnType<Engine['keys']>>,
  ciphertext: string | null = null,
): OperationResult {
  e.resolvedKeys = keys;
  requireThat(actor.role === 'judge', 'FORBIDDEN', '只有裁判可以执行指令。', 403);
  permission(actor, 'overview');
  strict(raw, ['request_id', 'command', 'reason', 'expected_revision', 'preview_token']);
  let node = parseCommandTree(text(raw.command, COMMAND_LIMITS.bytes)),
    spec = commandSpec(node);
  need(spec, '无法识别命令，请输入/help');
  if (node.words[0] === 'request') {
    need(node.words.length === 3 && node.words[1] === 'inspect', '用法：request inspect REQ-ID');
    const result = e.result(actor, node.words[2]!);
    recordCommand(
      e,
      actor,
      id,
      spec.path,
      'queried',
      {
        reference: node.words[2],
        watermark: e.db.match().revision,
        resultStatus: result.status,
      },
      ciphertext,
    );
    return result;
  }
  if (node.words[0] === 'plan' && ['inspect', 'cancel'].includes(node.words[1]!)) {
    const row = obj(e, node.words[2]!, 'plan');
    owner(context(e, actor, id, prepared), row);
    const data = JSON.parse(row.data) as PlanData;
    permission(actor, commandSpec(data.node)!.permission);
    if (node.words[1] === 'cancel') {
      need(row.status === 'pending', '只能关闭未执行计划');
      e.db.exec("UPDATE command_objects SET status='cancelled' WHERE id=?", row.id);
    }
    recordCommand(
      e,
      actor,
      id,
      spec.path,
      node.words[1] === 'cancel' ? 'cancelled' : 'queried',
      {
        plan: row.id,
        before: { status: row.status },
        after: { status: node.words[1] === 'cancel' ? 'cancelled' : row.status },
        preview: data.preview,
      },
      ciphertext,
    );
    return completed(
      id,
      '计划详情',
      JSON.stringify({
        id: row.id,
        status: node.words[1] === 'cancel' ? 'cancelled' : row.status,
        preview: data.preview,
      }),
    );
  }
  if (node.words[0] === 'confirm' || raw.preview_token) {
    const token = node.words[0] === 'confirm' ? node.words[1]! : text(raw.preview_token, 100),
      row = obj(e, token, 'plan');
    need(row.actor === actor.id, '计划必须由创建裁判确认');
    const data = JSON.parse(row.data) as PlanData;
    if (raw.preview_token)
      need(stableJson(node) === stableJson(data.node), '输入与已预览计划不一致');
    if (row.status === 'complete') {
      need(data.result, '计划结果缺失');
      recordCommand(
        e,
        actor,
        id,
        commandSpec(data.node)!.path,
        'replayed',
        {
          plan: row.id,
          originalRequestId: data.result.requestId,
        },
        ciphertext,
      );
      return { ...data.result, requestId: id };
    }
    need(row.status === 'pending', '该计划已关闭或失效');
    const c = context(e, actor, id, prepared);
    c.reason = data.reason;
    for (const [key, before] of Object.entries(data.dependencies)) {
      const current =
        key === 'match' || key === 'permissions'
          ? c.dependencies[key]
          : currentDependency(e, key, c.initial);
      requireThat(
        stableJson(before) === stableJson(current),
        'PLAN_DEPENDENCY_CHANGED',
        '计划依赖已变化，请重新预览：' + key,
      );
    }
    // Revalidate all current business conditions, including UTC cutoffs, before drawing or writing.
    simulate(e, actor, `check-${id}`, data.node, prepared, data.reason);
    const stateBefore = commandState(e);
    const previous = e.commandBatch;
    e.commandBatch = true;
    let result: unknown;
    try {
      result = run(c, data.node);
    } finally {
      e.commandBatch = previous;
    }
    autoFinish(e, e.game(), e.now(), `judge:${actor.id}:${id}`);
    e.db.bump();
    const response = completed(
      id,
      '指令已执行',
      JSON.stringify({ result, changes: c.changes, notes: c.notes }),
      { revision: e.db.match().revision },
    );
    data.result = response;
    e.db.exec(
      "UPDATE command_objects SET status='complete',data=? WHERE id=?",
      JSON.stringify(data),
      row.id,
    );
    recordCommand(
      e,
      actor,
      id,
      commandSpec(data.node)!.path,
      c.changes.length ? 'executed' : 'no_op',
      {
        plan: row.id,
        reason: data.reason,
        source: data.node.options.source ?? 'judge_intervention',
        caseId: data.node.options.case ?? null,
        targets: actualTargets(c.changes),
        changes: c.changes,
        preview: data.preview,
        parameters: {
          argumentCount: data.node.words.length,
          optionNames: Object.keys(data.node.options),
        },
        before: stateBefore,
        after: commandState(e),
        result: { status: response.status, revision: response.revision, result },
      },
      ciphertext,
    );
    return response;
  }
  let explicit = node.words[0] === 'plan';
  if (explicit) {
    node = { ...node, words: node.words.slice(1) };
    spec = commandSpec(node);
    need(spec && !spec.query, 'plan需要一个写操作');
  }
  const reason =
    node.options.reason ??
    (typeof raw.reason === 'string' && raw.reason.trim() ? raw.reason : '裁判主动干预');
  const c = context(e, actor, id, prepared);
  c.reason = reason;
  if (spec.query) {
    optionsCheck(node);
    const result = query(c, node);
    recordCommand(
      e,
      actor,
      id,
      spec.path,
      'queried',
      {
        watermark: e.db.match().revision,
        projection: spec.path,
        count: Array.isArray(result)
          ? result.length
          : result && typeof result === 'object' && 'items' in result && Array.isArray(result.items)
            ? result.items.length
            : 1,
        filters: Object.fromEntries(
          Object.entries(node.options).map(([key, value]) => [
            key,
            key === 'search' ? '检索词保存在加密原文' : value,
          ]),
        ),
        targets: Object.keys(c.dependencies)
          .filter((key) => key.startsWith('player:'))
          .map((key) => key.slice(7)),
      },
      ciphertext,
    );
    return completed(id, '查询完成', JSON.stringify(result, null, 2));
  }
  // Fixed macro versions are stored in the plan, never resolved again after confirmation.
  if (spec.path !== 'macro define') pin(c, node);
  if (spec.direct && !explicit && !path.endsWith('/preview')) {
    const stateBefore = commandState(e);
    const result = run(c, node);
    e.db.bump();
    recordCommand(
      e,
      actor,
      id,
      spec.path,
      'saved',
      {
        reason,
        source: c.source,
        targets: actualTargets(c.changes),
        changes: c.changes,
        before: stateBefore,
        after: commandState(e),
        result,
      },
      ciphertext,
    );
    return completed(id, '已保存', JSON.stringify({ result, changes: c.changes }));
  }
  explicit = explicit || path.endsWith('/preview');
  void explicit;
  const previewContext = simulate(e, actor, id, node, prepared, reason),
    token = `PLAN-${crypto.randomUUID()}`;
  const preview: ManagementPreview = {
    token,
    revision: e.db.match().revision,
    title: '指令影响预览',
    changes: previewContext.changes,
    consequences: [
      ...new Set([
        reason,
        ...previewContext.notes,
        '随机预览只展示候选及示例影响；实际目标在确认事务内抽取。',
      ]),
    ],
  };
  e.db.exec(
    'INSERT INTO command_objects(id,kind,actor,status,created_utc,data) VALUES(?,?,?,?,?,?)',
    token,
    'plan',
    actor.id,
    'pending',
    e.now(),
    JSON.stringify({
      node,
      reason,
      dependencies: previewContext.dependencies,
      preview,
    } satisfies PlanData),
  );
  recordCommand(
    e,
    actor,
    id,
    spec.path,
    'previewed',
    {
      plan: token,
      reason,
      source: node.options.source ?? c.source,
      preview,
      targets: actualTargets(previewContext.changes),
      parameters: { argumentCount: node.words.length, optionNames: Object.keys(node.options) },
    },
    ciphertext,
  );
  return completed(id, '请核对操作影响', `确认：/confirm ${token}`, { preview });
}
export function recordCommand(
  e: Engine,
  actor: Actor,
  id: string,
  path: string,
  status: string,
  detail: unknown,
  ciphertext: string | null = null,
): void {
  const facts =
    detail && typeof detail === 'object' ? (detail as Record<string, unknown>) : { detail };
  let auditId: string | null = null;
  if (
    facts.before !== undefined &&
    facts.after !== undefined &&
    !['queried', 'previewed'].includes(status)
  ) {
    const targets = Array.isArray(facts.targets) ? facts.targets : [];
    e.audit(
      actor.id,
      'command:' + path,
      targets.length === 1 ? String(targets[0]) : e.db.match().id,
      typeof facts.reason === 'string' ? facts.reason : '裁判指令记录',
      { requestId: id, status, ...facts },
    );
    auditId = e.db.one<{ id: string }>('SELECT id FROM audit_logs ORDER BY seq DESC LIMIT 1')!.id;
  }
  e.db.exec(
    'INSERT INTO judge_command_log(id,actor,request_id,status,path,created_utc,game_ms,detail,ciphertext) VALUES(?,?,?,?,?,?,?,?,?)',
    crypto.randomUUID(),
    actor.id,
    id,
    status,
    path,
    e.now(),
    e.game(),
    JSON.stringify({
      ...facts,
      auditId,
      identity: e.db.one(
        'SELECT account_id,assignment_id,name FROM memberships WHERE local_id=?',
        actor.id,
      ) ?? { name: actor.name, legacySeat: true },
    }),
    ciphertext,
  );
}
export async function prepareCommandCredentials(e: Engine, creators: string[]): Promise<void> {
  const accounts = e.db.all<{ id: string }>(
    "SELECT id FROM accounts WHERE instr(permissions,'system')=0",
  );
  const entries = await Promise.all(
    [...new Set(creators)].flatMap((actor) =>
      accounts.map(
        async (account) => [`${actor}:${account.id}`, await prepareCredential(e, actor)] as const,
      ),
    ),
  );
  e.commandCredentials = Object.fromEntries(entries);
}
export function executeCommandEvent(e: Engine, event: Scheduled): void {
  const payload = JSON.parse(event.payload) as { id?: string; job?: string; index?: number };
  const row = obj(e, payload.id ?? payload.job!, payload.job ? 'job' : 'schedule');
  if (row.status !== 'pending') return;
  const actor = e.db.one<Actor>('SELECT * FROM accounts WHERE id=?', row.actor);
  if (e.db.one('SELECT id FROM match_identity') && !e.taskAuthorization.has(row.actor)) {
    e.db.exec("UPDATE command_objects SET status='review',version=version+1 WHERE id=?", row.id);
    return;
  }
  if (!actor?.enabled) {
    e.db.exec("UPDATE command_objects SET status='failed' WHERE id=?", row.id);
    if (actor)
      recordCommand(
        e,
        actor,
        row.id,
        payload.job ? 'job step' : 'schedule due',
        'rejected',
        { parent: row.id, eventId: event.id, code: 'AUTHOR_DISABLED', originalDue: event.due },
        null,
      );
    return;
  }
  const c = context(e, actor, `${row.id}-${payload.index ?? 0}`, e.commandPrepared);
  c.reason = '裁判定时授权';
  c.deferred = true;
  if (payload.job) {
    const data = JSON.parse(row.data) as JobData;
    need(data.next === payload.index, '作业进度不一致');
    if (e.db.match().phase === 'ended' && !isMessage(e, data.steps[data.next]!)) {
      update(c, row, data, 'cancelled');
      recordCommand(
        e,
        actor,
        row.id,
        'job step',
        'cancelled',
        { parent: row.id, index: data.next, eventId: event.id, reason: '比赛已结束' },
        null,
      );
      return;
    }
    c.reason = data.reason;
    const stateBefore = commandState(e);
    try {
      const result = e.db.tx(() => {
        const prior = e.commandBatch;
        e.commandBatch = true;
        try {
          return run(c, data.steps[data.next]!);
        } finally {
          e.commandBatch = prior;
        }
      });
      autoFinish(e, e.game(), e.now(), row.id);
      data.results.push(result ?? null);
      data.next++;
      update(c, row, data, data.next === data.steps.length ? 'complete' : 'pending');
      if (data.next < data.steps.length)
        e.schedule(`${row.id}:${data.next}`, 'judge_command_job', 'utc', e.now() + 1, 3, {
          job: row.id,
          index: data.next,
        });
      recordCommand(
        e,
        actor,
        row.id,
        'job step',
        'executed',
        {
          parent: row.id,
          index: payload.index,
          eventId: event.id,
          reason: c.reason,
          source: c.source,
          targets: actualTargets(c.changes),
          changes: c.changes,
          before: stateBefore,
          after: commandState(e),
          result,
        },
        null,
      );
    } catch (error) {
      data.error = error instanceof Error ? error.message : '步骤失败';
      update(c, row, data, 'failed');
      recordCommand(
        e,
        actor,
        row.id,
        'job step',
        'failed',
        {
          parent: row.id,
          eventId: event.id,
          reason: c.reason,
          before: stateBefore,
          after: commandState(e),
          index: data.next,
          error: data.error,
        },
        null,
      );
    }
    return;
  }
  const data = JSON.parse(row.data) as TaskData;
  if (e.db.match().phase === 'ended' && data.afterEnd === 'cancel') {
    update(c, row, data, 'cancelled');
    recordCommand(
      e,
      actor,
      row.id,
      'schedule due',
      'cancelled',
      { parent: row.id, eventId: event.id, originalDue: data.due, reason: '比赛已结束' },
      null,
    );
    return;
  }
  const lateness = Math.max(0, (event.clock === 'game' ? e.game() : e.now()) - event.due);
  if (
    (lateness > 0 && data.late !== 'run') ||
    (data.maxLateness !== null && lateness > data.maxLateness)
  ) {
    update(c, row, data, data.late === 'skip' ? 'skipped' : 'review');
    recordCommand(
      e,
      actor,
      row.id,
      'schedule due',
      data.late === 'skip' ? 'skipped' : 'review',
      {
        lateness,
        originalDue: data.due,
        parent: row.id,
        eventId: event.id,
      },
      null,
    );
    return;
  }
  c.reason = data.reason;
  c.source = data.source;
  c.caseId = data.caseId;
  e.commandSnapshot = data.snapshot;
  const stateBefore = commandState(e);
  try {
    const result = e.db.tx(() => {
      const prior = e.commandBatch;
      e.commandBatch = true;
      try {
        return run(c, data.node);
      } finally {
        e.commandBatch = prior;
      }
    });
    autoFinish(e, e.game(), e.now(), row.id);
    data.results = result;
    update(c, row, data, 'complete');
    recordCommand(
      e,
      actor,
      row.id,
      'schedule due',
      'executed',
      {
        parent: row.id,
        eventId: event.id,
        originalDue: data.due,
        lateness,
        reason: c.reason,
        source: c.source,
        caseId: c.caseId ?? null,
        targets: actualTargets(c.changes),
        changes: c.changes,
        before: stateBefore,
        after: commandState(e),
        result,
      },
      null,
    );
  } catch (error) {
    data.error = error instanceof Error ? error.message : '定时操作失败';
    update(c, row, data, 'failed');
    recordCommand(
      e,
      actor,
      row.id,
      'schedule due',
      'failed',
      {
        parent: row.id,
        eventId: event.id,
        error: data.error,
        reason: c.reason,
        before: stateBefore,
        after: commandState(e),
      },
      null,
    );
  } finally {
    e.commandSnapshot = {};
  }
}
