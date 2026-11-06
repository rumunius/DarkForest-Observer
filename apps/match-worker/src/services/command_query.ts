import type {SiteConfig} from '@darkforest/contracts';
import {
  integer,
  parseJson,
  scalarText,
} from '../../../../packages/contracts/src/backend';
import {
  COMMAND_LIMITS,
  COMMAND_SPECS,
  LANGUAGE_VERSION,
  commandSpec,
  durationMs,
  instantMs,
  type CommandNode,
} from '../../../../packages/contracts/src/commands';
import {civilization, matchProjection} from '../projections/snapshot';
import {
  Fault,
  accountPermissions,
  permission,
  requireThat,
} from '../storage/store';
import {accountList} from './accounts';
import {civilizationHistory} from './civilization_history';
import type {CommandContext} from './command_context';
import {
  validateCommandArguments,
  namedCommandObject,
  requireCommandArgument,
  commandObject,
  singleTarget,
  requireObjectOwner,
  parameterKeys,
  selectTargets,
  renderCommandTemplate,
  commandValue,
} from './command_context';
import {score, targets} from './command_targets';
import {survivors} from './life';

/** 允许命令分页读取的表和字段白名单，不接受用户提供任意SQL标识符。 */
export const queryTables: Record<
  string,
  {table: string; permission?: string; id?: string; columns?: string}
> = {
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
  let conditions = `(${where})`;
  const args = [...bindings];
  if (opts.before) {
    requireCommandArgument(
      /^\d+$/.test(opts.before),
      '游标须为上一页nextCursor',
    );
    conditions += ' AND rowid<?';
    args.push(integer(Number(opts.before)));
  }
  const fields = commandContext.engine.db
    .all<{name: string}>(`PRAGMA table_info(${table})`)
    .map(r => r.name);
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
  for (const k of ['target', 'actor', 'kind', 'status']) {
    if (opts[k]) {
      if (table === 'judge_command_log' && k === 'target') {
        conditions +=
          " AND EXISTS(SELECT 1 FROM json_each(detail,'$.targets') WHERE value=?)";
        args.push(opts[k]);
        continue;
      }
      if (table === 'judge_command_log' && k === 'kind') {
        conditions += ' AND path=?';
        args.push(opts[k]);
        continue;
      }
      if (
        table === 'scheduled_events' &&
        k === 'status' &&
        opts[k] === 'failed'
      ) {
        conditions += " AND status='pending' AND last_error<>''";
        continue;
      }
      const col = mappings[k]!;
      requireCommandArgument(fields.includes(col), '该列表不支持 --' + k);
      conditions += ` AND ${col}=?`;
      args.push(opts[k]);
    }
  }
  const timeCol = fields.find(f =>
    ['created_utc', 'utc_ms', 'committed_utc', 'issued_utc'].includes(f),
  );
  for (const k of ['since', 'until']) {
    if (opts[k]) {
      requireCommandArgument(timeCol, '此列表没有时间范围字段');
      conditions += ` AND ${timeCol}${k === 'since' ? '>=' : '<='}?`;
      args.push(instantMs(opts[k]));
    }
  }
  if (opts.search) {
    const searchable = fields.filter(f =>
      ['title', 'body', 'path', 'reason', 'nickname', 'name', 'id'].includes(f),
    );
    requireCommandArgument(searchable.length, '此列表不支持搜索');
    conditions += ` AND (${searchable.map(f => `instr(${f},?)>0`).join(' OR ')}${table === 'judge_command_log' ? " OR instr(json_extract(detail,'$.reason'),?)>0" : ''})`;
    args.push(...searchable.map(() => opts.search!));
    if (table === 'judge_command_log') {
      args.push(opts.search);
    }
  }
  const rows = commandContext.engine.db.all<Record<string, SqlStorageValue>>(
    `SELECT rowid AS _cursor,${columns} FROM ${table} WHERE ${conditions} ORDER BY rowid DESC LIMIT ?`,
    ...args,
    limit + 1,
  );
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

/** 在目标和字段白名单内计算只读统计，不修改赛事状态或奖励。 */
export function statistic(
  commandContext: CommandContext,
  commandNode: CommandNode,
): unknown {
  const commandArguments = commandNode.words
    .slice(2)
    .map(v => commandValue(v, commandContext));
  const engine = commandContext.engine;
  if (commandNode.words[1] === 'count') {
    return {count: selectTargets(commandContext, commandArguments[0]!).length};
  }
  if (commandNode.words[1] === 'sum') {
    requireCommandArgument(
      commandArguments[1] === 'of',
      '用法：stats sum 字段 of 目标',
    );
    return {
      field: commandArguments[0],
      sum: selectTargets(commandContext, commandArguments[2]!).reduce(
        (sum, id) => sum + score(engine, id, commandArguments[0]!),
        0,
      ),
    };
  }
  const kind = commandArguments[0];
  const window = commandArguments[2] ? durationMs(commandArguments[2]) : null;
  requireCommandArgument(
    !commandArguments[1] || commandArguments[1] === 'window',
    '时间窗口须使用window',
  );
  const lower = window === null ? null : Math.max(0, engine.game() - window);
  let where =
    lower === null
      ? '1=1'
      : lower === 0
        ? 'game_ms>=0 AND game_ms<=?'
        : 'game_ms>? AND game_ms<=?';
  const args: SqlStorageValue[] =
    lower === null
      ? []
      : lower === 0
        ? [engine.game()]
        : [lower, engine.game()];
  if (commandNode.options.target) {
    const ids = selectTargets(commandContext, commandNode.options.target);
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
  requireCommandArgument(table, '未注册的统计事件类别');
  if (kind === 'sighting-hit') {
    where += " AND classification='hit' AND valid=1";
  }
  if (kind === 'elimination') {
    where += ' AND valid=1';
  }
  if (kind === 'broadcast') {
    where += " AND kind='broadcast'";
  }
  if (kind === 'homeworld-destroyed') {
    where +=
      " AND ((kind IN ('singer','photon') AND civilization_ids<>'[]') OR title='裁判母星毁灭')";
  }
  for (const k of ['since', 'until']) {
    if (commandNode.options[k]) {
      where += ` AND ${kind === 'elimination' ? 'utc_ms' : kind === 'sighting-hit' ? 'committed_utc' : 'utc_ms'}${k === 'since' ? '>=' : '<='}?`;
      args.push(instantMs(commandNode.options[k]));
    }
  }
  return {
    kind,
    count: engine.db.one<{n: number}>(
      `SELECT COUNT(*) n FROM ${table} WHERE ${where}`,
      ...args,
    )!.n,
    windowMs: window,
  };
}

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
  if (path === 'help') {
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
  if (path === 'version') {
    return {
      language: LANGUAGE_VERSION,
      implementation: 1,
      limits: COMMAND_LIMITS,
    };
  }
  if (path === 'whoami' || path === 'capability list') {
    return {
      actor: commandContext.actor.id,
      match: engine.db.match().id,
      permissions: accountPermissions(commandContext.actor),
    };
  }
  if (path === 'selector inspect') {
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
  if (path === 'clock status' || path === 'match status') {
    return matchProjection(engine);
  }
  if (path === 'clock pauses') {
    return page(commandContext, commandNode, 'clock_pauses');
  }
  if (path === 'roster list') {
    return engine.db
      .roster()
      .map(id => ({id, nickname: engine.db.player(id).nickname}));
  }
  if (path === 'preflight list') {
    return engine.db.roster().map(id => ({
      id,
      flight: engine.db.flight(id),
      verified: engine.db.home(id)?.status === 'verified',
    }));
  }
  if (path === 'player list') {
    return page(
      commandContext,
      commandNode,
      'players',
      'id,nickname,entry_status,tech,photons,broadcasts',
    );
  }
  if (path === 'inspect') {
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
  if (path === 'player resources') {
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
  if (path === 'player restrictions') {
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
  if (path === 'history') {
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
  if (path === 'homeworld pending') {
    return page(
      commandContext,
      commandNode,
      'homeworlds',
      '*',
      "status='pending'",
    );
  }
  if (path === 'homeworld inspect') {
    return (
      engine.db.home(singleTarget(commandContext, commandArguments[0]!)) ?? null
    );
  }
  if (path === 'codebook status') {
    return {
      capacity: 350,
      issued: engine.db.one<{n: number}>(
        'SELECT COUNT(*) n FROM sighting_codes',
      )!.n,
    };
  }
  if (path === 'tag list') {
    return engine.db.all<Record<string, SqlStorageValue>>(
      'SELECT tag FROM command_tags WHERE player_id=? ORDER BY tag',
      singleTarget(commandContext, commandArguments[0]!),
    );
  }
  if (path === 'observer status') {
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
  if (path === 'scheduler health') {
    return {
      health: engine.db.one<Record<string, SqlStorageValue>>(
        'SELECT * FROM scheduler_health',
      ),
      failed: engine.db.all<Record<string, SqlStorageValue>>(
        "SELECT id,last_error,last_error_utc,attempt_count FROM scheduled_events WHERE last_error<>'' AND status='pending'",
      ),
    };
  }
  if (path === 'hunt status') {
    return {
      phase: engine.db.match().phase,
      paused: engine.db.match().pause_reason,
      finalized: engine.db.match().hunt_finalized,
      alive: survivors(engine),
    };
  }
  if (path === 'parameter list') {
    return engine.db.parameters();
  }
  if (path === 'parameter inspect') {
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
  if (path === 'setting list' || path === 'palette list') {
    const site = parseJson(engine.db.match().site_json) as SiteConfig;
    return path === 'palette list' ? site.colors : site;
  }
  if (path === 'account list' || path === 'account inspect') {
    const accounts = accountList(engine, commandContext.actor);
    return path.endsWith('list')
      ? accounts
      : (accounts.find(x => x.id === commandArguments[0]) ?? null);
  }
  if (path === 'session list') {
    return engine.db.all<Record<string, SqlStorageValue>>(
      'SELECT account_id,expires,revoked FROM sessions WHERE account_id=?',
      commandArguments[0]!,
    );
  }
  if (path === 'recovery status' || path === 'recovery checklist') {
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
  if (words[0] === 'stats') {
    return statistic(commandContext, commandNode);
  }
  if (
    ['case', 'schedule', 'macro', 'job', 'export', 'template'].includes(
      words[0]!,
    ) ||
    path === 'hunt draft inspect'
  ) {
    const kind = path === 'hunt draft inspect' ? 'hunt' : words[0]!;
    if (words[1] === 'list') {
      const all =
        ['macro', 'template'].includes(kind) ||
        accountPermissions(commandContext.actor).includes('commands');
      return page(
        commandContext,
        commandNode,
        'command_objects',
        '*',
        all ? 'kind=?' : 'kind=? AND actor=?',
        all ? [kind] : [kind, commandContext.actor.id],
      );
    }
    if (kind === 'macro' || kind === 'template') {
      const row = namedCommandObject(
        commandContext,
        kind,
        commandArguments[0]!,
        kind === 'macro' && commandArguments[2] !== undefined
          ? Number(commandArguments[2])
          : undefined,
      );
      if (path === 'template preview') {
        const id = singleTarget(commandContext, commandArguments[2]!);
        return renderCommandTemplate(
          commandContext,
          (parseJson(row.data) as {body: string}).body,
          id,
        );
      }
      return {...row, data: parseJson(row.data)};
    }
    const row = commandObject(engine, commandArguments[0]!, kind);
    requireObjectOwner(commandContext, row);
    if (path === 'case graph') {
      const data = parseJson(row.data) as {
        evidence: Array<{ref: string | null; note: string}>;
      };
      const audits = engine.db.all<{
        id: string;
        action: string;
        target: string;
      }>(
        "SELECT id,action,target FROM audit_logs WHERE json_extract(detail,'$.caseId')=? ORDER BY seq",
        row.id,
      );
      const objects = engine.db.all<{id: string; kind: string; status: string}>(
        "SELECT id,kind,status FROM command_objects WHERE json_extract(data,'$.caseId')=? ORDER BY created_utc,id",
        row.id,
      );
      return {
        case: {...row, data},
        nodes: [
          {id: row.id, kind: 'case'},
          ...data.evidence
            .filter(x => x.ref)
            .map(x => ({id: x.ref, kind: 'reference'})),
          ...audits.map(x => ({...x, kind: 'audit'})),
          ...objects,
        ],
        edges: [
          ...data.evidence
            .filter(x => x.ref)
            .map(x => ({
              from: row.id,
              to: x.ref,
              relation: 'evidence',
              note: x.note,
            })),
          ...audits.map(x => ({from: row.id, to: x.id, relation: 'operation'})),
          ...objects.map(x => ({
            from: row.id,
            to: x.id,
            relation: 'authorization',
          })),
        ],
      };
    }
    return {...row, data: parseJson(row.data)};
  }
  const config = queryTables[words[0]!];
  if (config) {
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
          engine.db.one<{v: number}>(
            'SELECT MAX(version) v FROM result_reports',
          )?.v ??
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
  throw new Fault(400, 'UNKNOWN_QUERY', '查询路径未注册。');
}
