import type {ManagementPreview, OperationResult} from '@darkforest/contracts';
import {
  parseJson,
  stableJson,
} from '../../../../packages/contracts/src/backend';
import {
  commandSpec,
  type CommandNode,
} from '../../../../packages/contracts/src/commands';
import {TIMES} from '../domain/rules';
import {
  accountPermissions,
  permission,
  requireThat,
  type Actor,
  type Parameters,
} from '../storage/store';
import {targets} from './command_targets';
import {type Engine, type PreparedCode} from './engine';
import {judgeAction, previewAction} from './judge';
import {logEvent, survivors} from './life';

/** 持久命令对象行，版本、创建者和状态用于模板、计划与任务管理。 */
export interface SavedCommandObject {
  id: string;
  kind: string;
  actor: string;
  status: string;
  version: number;
  created_utc: number;
  data: string;
}

/** 一次命令模拟或提交的执行上下文，集中保存工作预算、依赖及审计变化。 */
export interface CommandContext {
  engine: Engine;
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
}

/** 解码解析器已验证的引号参数，未提供参数时使用空文本。 */
export function unquoteArgument(v: string | undefined) {
  return v?.startsWith('"') ? (parseJson(v) as string) : (v ?? '');
}

/** 在当前命令标量绑定中解析参数，未绑定时按普通参数解码。 */
export function commandValue(
  v: string | undefined,
  commandContext: CommandContext,
) {
  return v && v in commandContext.scalars
    ? commandContext.scalars[v]!
    : unquoteArgument(v);
}

/** 将命令参数或条件失败转换为可展示的400错误，终止本次处理。 */
export function requireCommandArgument(
  condition: unknown,
  message: string,
): asserts condition {
  requireThat(condition, 'COMMAND_ARGUMENT', message, 400);
}

/** 读取指定类别的持久命令对象，缺失或类别不符时拒绝操作。 */
export function commandObject(
  engine: Engine,
  id: string,
  kind?: string,
): SavedCommandObject {
  const row = engine.db.one<SavedCommandObject>(
    'SELECT * FROM command_objects WHERE id=?',
    id,
  );
  requireThat(
    row && (!kind || row.kind === kind),
    'COMMAND_OBJECT_NOT_FOUND',
    '未找到对应记录：' + id,
    404,
  );
  return row;
}

/** 在当前命令事务内保存带创建者和来源的对象，ID绑定请求与工作序号。 */
export function saveCommandObject(
  commandContext: CommandContext,
  kind: string,
  data: unknown,
  prefix = kind.toUpperCase(),
  status = 'active',
): string {
  const id = `${prefix}-${commandContext.id}-${commandContext.work}`;
  commandContext.engine.db.exec(
    'INSERT INTO command_objects(id,kind,actor,status,created_utc,data) VALUES(?,?,?,?,?,?)',
    id,
    kind,
    commandContext.actor.id,
    status,
    commandContext.engine.now(),
    stableJson(data),
  );
  return id;
}

/** 更新命令对象内容并推进版本，使旧预览和任务引用可检测变化。 */
export function updateCommandObject(
  commandContext: CommandContext,
  row: SavedCommandObject,
  data: unknown,
  status = row.status,
): void {
  commandContext.engine.db.exec(
    'UPDATE command_objects SET data=?,status=?,version=version+1 WHERE id=?',
    stableJson(data),
    status,
    row.id,
  );
}

/** 捕获命令依赖的权威状态快照，供模拟和确认时检查变化。 */
export function captureCommandDependencies(
  engine: Engine,
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const p of engine.db.all<{id: string}>(
    'SELECT id FROM players ORDER BY id',
  )) {
    result['player:' + p.id] = {
      player: engine.db.player(p.id),
      flight: engine.db.flight(p.id),
      home: engine.db.home(p.id) ?? null,
      control: engine.db.one<Record<string, SqlStorageValue>>(
        'SELECT * FROM attack_controls WHERE player_id=?',
        p.id,
      ),
      elimination:
        engine.db.one<Record<string, SqlStorageValue>>(
          'SELECT * FROM eliminations WHERE player_id=? AND valid=1',
          p.id,
        ) ?? null,
      tags: engine.db.all<Record<string, SqlStorageValue>>(
        'SELECT tag FROM command_tags WHERE player_id=? ORDER BY tag',
        p.id,
      ),
    };
  }
  return result;
}

/** 首次记录某项依赖，避免后续步骤覆盖预览依据。 */
export function recordDependency(
  commandContext: CommandContext,
  key: string,
  data: unknown,
): void {
  if (!(key in commandContext.dependencies)) {
    commandContext.dependencies[key] = data;
  }
}

/** 解析目标集合并登记选择器依赖；随机候选的预览示例不代表最终抽签。 */
export function selectTargets(
  commandContext: CommandContext,
  v: string,
  allowPool = false,
): string[] {
  if (!allowPool) {
    requireCommandArgument(
      !v.startsWith('@pool'),
      '本操作不接受候选账号池，请选择正式文明。',
    );
  }
  const set = targets(
    commandContext.engine,
    v,
    commandContext.self,
    commandContext.preview,
    commandContext.bindings,
  );
  for (const id of set.candidates) {
    recordDependency(
      commandContext,
      'player:' + id,
      commandContext.initial['player:' + id],
    );
  }
  if (v.startsWith('@') && v !== '@s') {
    recordDependency(
      commandContext,
      'roster',
      commandContext.engine.db.roster(),
    );
    recordDependency(
      commandContext,
      'selector-roster',
      commandContext.engine.db
        .roster()
        .map(id => commandContext.initial['player:' + id]),
    );
  }
  if (set.random) {
    commandContext.notes.push(
      `随机候选：${set.candidates.join('、') || '无'}；均匀无放回抽取${set.count}人，确认时只抽一次。预览示例不是抽签结果。`,
    );
  }
  return set.ids;
}

/** 要求选择器恰好产生一个目标；多目标应通过组合命令明确执行。 */
export function singleTarget(
  commandContext: CommandContext,
  v: string,
): string {
  const ids = selectTargets(commandContext, v);
  requireCommandArgument(
    ids.length === 1,
    '本操作需要唯一文明；集合请使用execute as。',
  );
  return ids[0]!;
}

/** 向当前命令追加可展示的前后变化，供确认预览与执行审计共同使用。 */
export function recordChange(
  commandContext: CommandContext,
  target: string,
  before: unknown,
  after: unknown,
): void {
  commandContext.changes.push({
    target,
    before: typeof before === 'string' ? before : stableJson(before),
    after: typeof after === 'string' ? after : stableJson(after),
  });
}

/** 要求总裁判权限；平台管理员身份不能隐式绕过本场职责。 */
export function requireHeadJudge(commandContext: CommandContext): void {
  permission(commandContext.actor, 'commands');
}

/** 要求比赛处于可管理的运行阶段，已结束比赛保留其他专用读取入口。 */
export function requireRunningMatch(commandContext: CommandContext): void {
  const m = commandContext.engine.db.match();
  requireThat(
    m.start_settled !== null && m.phase !== 'ended',
    'MATCH_NOT_RUNNING',
    '请在比赛中执行；赛后使用战报更正。',
  );
}

/** 要求操作仍在黑暗森林阶段内，避免资源或母星操作跨过阶段门禁。 */
export function requireForestPhase(commandContext: CommandContext): void {
  requireRunningMatch(commandContext);
  requireThat(
    commandContext.engine.db.match().phase === 'forest' &&
      commandContext.engine.game() < TIMES.apocalypse,
    'FOREST_REQUIRED',
    '该操作仅在65分钟前的第一阶段开放。',
  );
}

/** 要求目标仍具有效参赛资格，不能把已淘汰文明当作普通存活目标。 */
export function requireLivingTarget(
  commandContext: CommandContext,
  id: string,
): void {
  requireThat(
    survivors(commandContext.engine).includes(id),
    'TARGET_NOT_ALIVE',
    '目标不在正式存活名单中：' + id,
  );
}

/** 记录影响批量淘汰和提前完赛判断的存活集合依赖。 */
export function recordPopulationDependency(
  commandContext: CommandContext,
): void {
  recordDependency(
    commandContext,
    'population',
    survivors(commandContext.engine),
  );
}

/** 登记当前事件计划的依赖，确认时不能悄然替换既定事件。 */
export function eventDependencies(engine: Engine): unknown[] {
  return engine.db.all<Record<string, SqlStorageValue>>(
    'SELECT id,kind,clock,due,priority,status,payload,committed_utc FROM scheduled_events ORDER BY id',
  );
}

/** 把指定持久表加入预览依赖，表名只能来自内部固定调用点。 */
export function recordTableDependency(
  commandContext: CommandContext,
  table: string,
): void {
  recordDependency(
    commandContext,
    'table:' + table,
    commandContext.initial['table:' + table] ??
      commandContext.engine.db.all<Record<string, SqlStorageValue>>(
        `SELECT * FROM ${table}`,
      ),
  );
}

/** 让命令复用裁判业务服务和真实预览，避免另建绕过校验的写入路径。 */
export function invokeJudgeAction(
  commandContext: CommandContext,
  path: string,
  payload: Record<string, unknown>,
): OperationResult {
  const engine = commandContext.engine;
  const id = `${commandContext.id}-${commandContext.work}`;
  const body = {
    ...payload,
    reason: commandContext.reason,
    expected_revision: engine.db.match().revision,
  };
  const managementPreview = previewAction(engine, commandContext.actor, id, {
    ...body,
    path,
    change: path,
  }).preview!;
  commandContext.changes.push(...managementPreview.changes);
  commandContext.notes.push(...managementPreview.consequences);
  return judgeAction(
    engine,
    commandContext.actor,
    id,
    path,
    {...body, preview_token: managementPreview.token},
    commandContext.prepared,
  );
}

/** 命令参数名称到服务器设置字段的白名单映射。 */
export const parameterKeys: Record<string, keyof Parameters> = {
  'singer-percent': 'singerPercent',
  'wrong-first-lock': 'firstLockSeconds',
  'wrong-second-lock': 'secondLockSeconds',
  'wrong-second-out-percent': 'secondOutPercent',
  'respawn-window': 'respawnSeconds',
  'observer-wait': 'observerWaitSeconds',
  'sighting-min-interval': 'sightingIntervalMs',
  'sighting-per-minute': 'sightingsPerMinute',
};

/** 公开站点设置的命令白名单；不包含密钥、绑定或任意环境配置。 */
export const settingKeys: Record<
  string,
  'title' | 'description' | 'qqGroup' | 'judgeContact' | 'endgameFile'
> = {
  'activity-name': 'title',
  'activity-description': 'description',
  'qq-group-name': 'qqGroup',
  'qq-group-number': 'qqGroup',
  'judge-contact': 'judgeContact',
  'qq-material-name': 'endgameFile',
};

/** 仅替换已注册的命令模板字段，未知占位符会拒绝，不执行任意表达式。 */
export function renderCommandTemplate(
  commandContext: CommandContext,
  body: string,
  id?: string,
): string {
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
    nickname: id ? (commandContext.engine.db.player(id).nickname ?? id) : '',
    phase:
      phases[commandContext.engine.db.match().phase] ?? '请查看当前比赛状态',
    game_time: String(commandContext.engine.game()),
  };
  return body.replace(/\$\{([^}]+)\}/g, (_m, k: string) => {
    requireCommandArgument(k in allowed, '未注册的模板字段：' + k);
    return allowed[k]!;
  });
}

/** 生成带来源和受众的管理消息及通知待办，不宣称已经通过QQ发送。 */
export function emitCommandMessage(
  commandContext: CommandContext,
  ids: string[],
  body: string,
  group = false,
): void {
  const engine = commandContext.engine;
  const source = `judge:${commandContext.actor.id}:${commandContext.id}:${commandContext.work}`;
  if (
    group &&
    ids.length === engine.db.roster().length &&
    ids.every(id => engine.db.roster().includes(id))
  ) {
    const rendered = renderCommandTemplate(commandContext, body);
    logEvent(
      engine,
      source,
      'notice',
      '赛事通知',
      rendered,
      'public',
      [],
      engine.game(),
      engine.now(),
    );
    engine.notice(source, 'group', '赛事通知', rendered);
  } else {
    for (const id of ids) {
      const rendered = renderCommandTemplate(commandContext, body, id);
      logEvent(
        engine,
        `${source}:${id}`,
        'notice',
        '赛事通知',
        rendered,
        'personal',
        [id],
        engine.game(),
        engine.now(),
        id,
      );
      engine.notice(source, id, '赛事通知', rendered);
    }
  }
  recordChange(
    commandContext,
    group ? '公告' : '私信',
    `${ids.length}名收件人`,
    body,
  );
}

/** 拒绝命令目录没有注册的选项，避免拼写错误被静默忽略。 */
export function validateCommandOptions(commandNode: CommandNode): void {
  const spec = commandSpec(commandNode);
  requireCommandArgument(
    spec,
    '无法识别命令路径：' + commandNode.words.slice(0, 3).join(' '),
  );
  const list =
    spec.path.endsWith(' list') ||
    [
      'command history',
      'history',
      'homeworld pending',
      'report versions',
      'clock pauses',
    ].includes(spec.path);
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
    ...(spec.path === 'stats events'
      ? ['target', 'since', 'until', 'format']
      : []),
    ...(spec.path === 'batch run' ? ['mode'] : []),
    ...(spec.path === 'schedule create'
      ? ['targets', 'late', 'max-lateness', 'after-end']
      : []),
    ...(spec.path === 'effect create attack-silence' ? ['end-at'] : []),
  ]);
  for (const key of Object.keys(commandNode.options)) {
    requireCommandArgument(allowed.has(key), '该命令不接受 --' + key);
  }
}

/** 按共享命令目录检查位置参数与选项组合，执行前仍需业务校验。 */
export function validateCommandArguments(commandNode: CommandNode): void {
  const spec = commandSpec(commandNode)!;
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
  ) {
    return;
  }
  const tokens = spec.args.split(/\s+/).filter(Boolean);
  const commandArguments = commandNode.words.slice(spec.path.split(' ').length);
  const min = spec.args.includes('[')
    ? spec.args
        .slice(0, spec.args.indexOf('['))
        .trim()
        .split(/\s+/)
        .filter(Boolean).length
    : tokens.length;
  requireCommandArgument(
    commandArguments.length >= min && commandArguments.length <= tokens.length,
    `用法：/${spec.path} ${spec.args}`,
  );
  tokens.forEach((t, i) => {
    if (commandArguments[i] !== undefined && !/[<>[\]{}]/.test(t)) {
      requireCommandArgument(commandArguments[i] === t, `参数关键字应为 ${t}`);
    }
  });
  requireCommandArgument(!commandNode.block, `/${spec.path} 不接受操作块`);
}

/** 要求对象创建者或具备命令管理职责的裁判，防止跨作者修改任务。 */
export function requireObjectOwner(
  commandContext: CommandContext,
  row: SavedCommandObject,
): void {
  requireThat(
    row.actor === commandContext.actor.id ||
      accountPermissions(commandContext.actor).includes('commands'),
    'FORBIDDEN',
    '只能管理本人创建的任务。',
    403,
  );
}

/** 按名称和类别查找持久命令对象，保留版本与归属边界。 */
export function namedCommandObject(
  commandContext: CommandContext,
  kind: string,
  name: string,
  version?: number,
): SavedCommandObject {
  const rows = commandContext.engine.db.all<SavedCommandObject>(
    "SELECT * FROM command_objects WHERE kind=? AND json_extract(data,'$.name')=? ORDER BY version DESC",
    kind,
    name,
  );
  const row = rows.find(r =>
    version ? r.version === version : r.status === 'active',
  );
  requireThat(row, 'VERSION_NOT_FOUND', '没有对应的有效版本。', 404);
  return row;
}
