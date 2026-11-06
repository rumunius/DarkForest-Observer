import type {ManagementPreview, OperationResult} from '@darkforest/contracts';
import {integer, parseJson} from '../../../../packages/contracts/src/backend';
import {
  COMMAND_LIMITS,
  commandSpec,
  durationMs,
  instantMs,
  type CommandNode,
} from '../../../../packages/contracts/src/commands';
import {Fault, permission, type Actor} from '../storage/store';
import {runBatch, runConditional} from './command_composition';
import type {CommandContext} from './command_context';
import {
  captureCommandDependencies,
  commandObject,
  commandValue,
  eventDependencies,
  namedCommandObject,
  recordChange,
  recordDependency,
  requireCommandArgument,
  saveCommandObject,
  unquoteArgument,
  validateCommandArguments,
  validateCommandOptions,
} from './command_context';
import {cancelCommandTask, executeCommandAction} from './command_execution';
import {
  defineMacro,
  retireMacro,
  runMacro,
  type MacroData,
} from './command_macros';
import {query} from './command_query';
import {targets} from './command_targets';
import {type Engine, type PreparedCode} from './engine';
import {survivors} from './life';
import {managementState} from './management_impact';

/** 固定组合命令所引用的宏版本，避免确认前模板变化悄然改变执行内容。 */
export function pin(
  commandContext: CommandContext,
  commandNode: CommandNode,
  stack: string[] = [],
): void {
  const spec = commandSpec(commandNode);
  requireCommandArgument(spec, '未注册的命令');
  validateCommandOptions(commandNode);
  permission(commandContext.actor, spec.permission);
  requireCommandArgument(
    !['plan', 'confirm', 'request'].includes(commandNode.words[0]!) &&
      !spec.query,
    '授权控制及查询不能嵌入操作块',
  );
  if (spec.path === 'macro run') {
    const name = unquoteArgument(commandNode.words[2]);
    const versionIndex = commandNode.words.indexOf('version');
    const row = namedCommandObject(
      commandContext,
      'macro',
      name,
      versionIndex >= 0
        ? Number(commandNode.words[versionIndex + 1])
        : undefined,
    );
    requireCommandArgument(!stack.includes(name), '宏不能直接或间接递归');
    const data = parseJson(row.data) as MacroData;
    if (versionIndex < 0) {
      commandNode.words.push('version', String(row.version));
    }
    for (const node of data.block) {
      pin(commandContext, node, [...stack, name]);
    }
  }
  for (const child of commandNode.block ?? []) {
    if (spec.path === 'reveal' && child.words[0] === 'stats') {
      permission(commandContext.actor, 'overview');
      validateCommandOptions(child);
      validateCommandArguments(child);
    } else {
      pin(commandContext, child, stack);
    }
  }
}

/** 解释共享命令树并复用领域处理器，维护组合深度、工作预算及原事务。 */
export function run(
  commandContext: CommandContext,
  commandNode: CommandNode,
): unknown {
  requireCommandArgument(
    ++commandContext.depth <= COMMAND_LIMITS.depth,
    '执行嵌套超过32层',
  );
  const prior = {
    reason: commandContext.reason,
    source: commandContext.source,
    caseId: commandContext.caseId,
    self: commandContext.self,
    bindings: commandContext.bindings,
    scalars: commandContext.scalars,
  };
  try {
    if (++commandContext.work > COMMAND_LIMITS.work) {
      throw new Fault(
        413,
        'COMMAND_BUDGET',
        '展开操作超出工作预算，请缩小批次。',
      );
    }
    validateCommandOptions(commandNode);
    const spec = commandSpec(commandNode)!;
    permission(commandContext.actor, spec.permission);
    commandContext.reason = commandNode.options.reason ?? commandContext.reason;
    commandContext.source = commandNode.options.source ?? commandContext.source;
    commandContext.caseId = commandNode.options.case ?? commandContext.caseId;
    if (commandContext.caseId) {
      const record = commandObject(
        commandContext.engine,
        commandContext.caseId,
        'case',
      );
      recordDependency(commandContext, 'object:' + record.id, record);
    }
    if (spec.query) {
      return query(commandContext, commandNode);
    }
    if (spec.path === 'batch run') {
      return runBatch(commandContext, commandNode, run, createJob);
    }
    if (spec.path === 'execute') {
      return runConditional(commandContext, commandNode, run);
    }
    if (spec.path === 'macro define') {
      return defineMacro(commandContext, commandNode, pin);
    }
    if (spec.path === 'macro run') {
      return runMacro(commandContext, commandNode, run);
    }
    if (spec.path === 'macro retire') {
      return retireMacro(commandContext, commandNode);
    }
    if (spec.path === 'schedule create') {
      return createSchedule(commandContext, commandNode);
    }
    if (spec.path === 'schedule cancel' || spec.path === 'job cancel') {
      return cancelCommandTask(commandContext, commandNode, spec.path);
    }
    return executeCommandAction(commandContext, commandNode, spec.path);
  } finally {
    Object.assign(commandContext, prior);
    commandContext.depth--;
  }
}

/** 持久定时命令的正文与目标快照，恢复后仍需重新核对创建者授权。 */
export interface TaskData {
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
}

function macroBody(
  engine: Engine,
  commandNode: CommandNode,
): CommandNode[] | undefined {
  if (commandSpec(commandNode)?.path !== 'macro run') {
    return;
  }
  const versionIndex = commandNode.words.indexOf('version');
  if (versionIndex < 0) {
    return;
  }
  const row = engine.db.one<{data: string}>(
    "SELECT data FROM command_objects WHERE kind='macro' AND json_extract(data,'$.name')=? AND version=?",
    unquoteArgument(commandNode.words[2]),
    integer(Number(commandNode.words[versionIndex + 1]), 1),
  );
  return row ? (parseJson(row.data) as MacroData).block : undefined;
}

/** 判断命令树是否仅产生管理消息，用于完赛后保留通知任务的策略。 */
export function isMessage(engine: Engine, commandNode: CommandNode): boolean {
  if (
    ['announce', 'tell', 'notice', 'reveal', 'replay'].includes(
      commandNode.words[0]!,
    )
  ) {
    return true;
  }
  const block =
    macroBody(engine, commandNode) ??
    (['batch', 'execute'].includes(commandNode.words[0]!)
      ? commandNode.block
      : undefined);
  if (block) {
    return block.every(child => isMessage(engine, child));
  }
  return false;
}

function collectSnapshot(
  commandContext: CommandContext,
  commandNode: CommandNode,
  result: Record<string, string[]>,
): void {
  for (const w of commandNode.words) {
    if (/^@(a|alive|dead|random|pool)(\[|$)/.test(w)) {
      result[w] = targets(
        commandContext.engine,
        w,
        commandContext.self,
        true,
        commandContext.bindings,
      ).candidates;
    }
  }
  for (const child of commandNode.block ?? []) {
    collectSnapshot(commandContext, child, result);
  }
  for (const child of macroBody(commandContext.engine, commandNode) ?? []) {
    collectSnapshot(commandContext, child, result);
  }
}

function createSchedule(
  commandContext: CommandContext,
  commandNode: CommandNode,
): unknown {
  requireCommandArgument(
    (commandNode.block?.length &&
      commandNode.words.length === 7 &&
      commandNode.words[5] === 'run') ||
      (commandNode.block?.length &&
        commandNode.words.length === 6 &&
        commandNode.words[5] === 'run'),
    '用法：schedule create utc|game in|at 时间 run { 操作 }',
  );
  const clock = commandNode.words[2];
  const mode = commandNode.words[3];
  const raw = commandValue(commandNode.words[4], commandContext);
  requireCommandArgument(
    clock === 'utc' || clock === 'game',
    '时基为utc或game',
  );
  requireCommandArgument(mode === 'at' || mode === 'in', '时间模式为at或in');
  const block = structuredClone(commandNode.block);
  for (const node of block) {
    pin(commandContext, node);
  }
  let due: number;
  if (mode === 'in') {
    due =
      (clock === 'utc'
        ? commandContext.engine.now()
        : commandContext.engine.game()) + durationMs(raw);
  } else if (clock === 'utc') {
    due = instantMs(raw);
  } else {
    const m = /^g(\d+):([0-5]\d)(?:\.(\d{3}))?$/.exec(raw);
    requireCommandArgument(m, '游戏时刻须为g分:秒[.毫秒]');
    due = Number(m[1]) * 60000 + Number(m[2]) * 1000 + Number(m[3] ?? 0);
  }
  integer(due);
  const node: CommandNode = {words: ['batch', 'run'], block, options: {}};
  const message = isMessage(commandContext.engine, node);
  const late = commandNode.options.late ?? (message ? 'run' : 'review');
  const afterEnd =
    commandNode.options['after-end'] ?? (message ? 'keep' : 'cancel');
  requireCommandArgument(
    ['run', 'skip', 'review'].includes(late),
    'late须为run/skip/review',
  );
  requireCommandArgument(
    ['keep', 'cancel'].includes(afterEnd),
    'after-end须为keep/cancel',
  );
  requireCommandArgument(
    afterEnd !== 'keep' || message,
    '混合或战局任务不能在赛后执行',
  );
  requireCommandArgument(
    !commandNode.options.targets ||
      ['live', 'snapshot'].includes(commandNode.options.targets),
    'targets为live或snapshot',
  );
  const snapshot: Record<string, string[]> = {};
  if (commandNode.options.targets === 'snapshot') {
    collectSnapshot(commandContext, node, snapshot);
  }
  const data: TaskData = {
    node,
    due,
    clock,
    late: late as TaskData['late'],
    maxLateness: commandNode.options['max-lateness']
      ? durationMs(commandNode.options['max-lateness'])
      : null,
    afterEnd: afterEnd as TaskData['afterEnd'],
    snapshot,
    reason: commandContext.reason,
    source: commandContext.source,
    caseId: commandContext.caseId,
  };
  const id = saveCommandObject(
    commandContext,
    'schedule',
    data,
    'SCH',
    'pending',
  );
  commandContext.engine.schedule(id, 'judge_command_task', clock, due, 3, {id});
  recordChange(
    commandContext,
    id,
    '无定时任务',
    `${clock === 'utc' ? new Date(due).toLocaleString('zh-CN', {timeZone: 'Asia/Shanghai'}) + ' 北京时间' : `有效比赛${due}毫秒`}；目标${commandNode.options.targets ?? 'live'}；迟到${late}；赛后${afterEnd}`,
  );
  commandContext.notes.push(
    '到期时重新检查创建者权限、比赛暂停情况、现场核对记录和当前操作条件。随机目标在执行时抽取；淘汰或恢复文明可能影响提前完赛。',
  );
  return {id};
}

/** 顺序作业的持久进度与步骤，失败后保持已完成步骤和原操作来源。 */
export interface JobData {
  steps: CommandNode[];
  next: number;
  results: unknown[];
  reason: string;
  error?: string;
}

function createJob(
  commandContext: CommandContext,
  steps: CommandNode[],
): unknown {
  const pinned = structuredClone(steps);
  for (const node of pinned) {
    pin(commandContext, node);
  }
  const id = saveCommandObject(
    commandContext,
    'job',
    {
      steps: pinned,
      next: 0,
      results: [],
      reason: commandContext.reason,
    } satisfies JobData,
    'JOB',
    'pending',
  );
  commandContext.engine.schedule(
    `${id}:0`,
    'judge_command_job',
    'utc',
    commandContext.engine.now(),
    3,
    {
      job: id,
      index: 0,
    },
  );
  recordChange(
    commandContext,
    id,
    '无作业',
    `${steps.length}步独立提交；失败停止，已提交步骤不回滚，每步检查提前完赛。`,
  );
  return {id};
}

/** 为模拟或提交创建独立执行上下文，包含当前账号、准备材料和预算。 */
export function createCommandContext(
  engine: Engine,
  actor: Actor,
  id: string,
  prepared: PreparedCode[],
  preview = false,
): CommandContext {
  const initial = captureCommandDependencies(engine);
  const matchState = engine.db.match();
  for (const table of [
    'settings',
    'sighting_codes',
    'attacks',
    'scheduled_events',
    'roster_members',
    'admin_effects',
    'result_reports',
  ]) {
    initial['table:' + table] =
      table === 'scheduled_events'
        ? eventDependencies(engine)
        : engine.db.all<Record<string, SqlStorageValue>>(
            `SELECT * FROM ${table}`,
          );
  }
  return {
    engine: engine,
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
        phase: matchState.phase,
        release_at: matchState.release_at,
        started_at: matchState.started_at,
        start_settled: matchState.start_settled,
        paused_at: matchState.paused_at,
        pause_reason: matchState.pause_reason,
        hunt_finalized: matchState.hunt_finalized,
        recovery_state: matchState.recovery_state,
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

/** 在可回滚的预览执行中收集真实变化与依赖，不把模拟结果直接当作提交。 */
export function simulate(
  engine: Engine,
  actor: Actor,
  id: string,
  node: CommandNode,
  prepared: PreparedCode[],
  reason: string,
): CommandContext {
  const commandContext = createCommandContext(
    engine,
    actor,
    id,
    prepared,
    true,
  );
  const rollback = new Error('COMMAND_PREVIEW_ROLLBACK');
  commandContext.reason = reason;
  const previous = engine.commandBatch;
  engine.commandBatch = true;
  try {
    engine.db.tx(() => {
      run(commandContext, node);
      const count = survivors(engine).length;
      if (engine.db.match().start_settled !== null && count <= 1) {
        commandContext.notes.push(`整批结束后存活${count}人，将提前完赛。`);
      }
      throw rollback;
    });
  } catch (error) {
    if (error !== rollback) {
      throw error;
    }
  } finally {
    engine.commandBatch = previous;
  }
  return commandContext;
}

/** 从当前权威状态重新读取一项预览依赖，用于确认时检测过时计划。 */
export function currentDependency(
  engine: Engine,
  key: string,
  initial: Record<string, unknown>,
): unknown {
  if (key in initial) {
    return initial[key];
  }
  if (key === 'roster') {
    return engine.db.roster();
  }
  if (key === 'population') {
    return survivors(engine);
  }
  if (key === 'site') {
    return parseJson(engine.db.match().site_json);
  }
  if (key.startsWith('object:')) {
    return engine.db.one<Record<string, SqlStorageValue>>(
      'SELECT * FROM command_objects WHERE id=?',
      key.slice(7),
    );
  }
  if (key.startsWith('notice:')) {
    return engine.db.one<Record<string, SqlStorageValue>>(
      'SELECT * FROM notice_queue WHERE id=?',
      key.slice(7),
    );
  }
  if (key.startsWith('account:')) {
    return engine.db.one<Record<string, SqlStorageValue>>(
      'SELECT version,enabled,permissions FROM accounts WHERE id=?',
      key.slice(8),
    );
  }
  if (key.startsWith('effect:')) {
    return (
      engine.db.one<Record<string, SqlStorageValue>>(
        'SELECT active,starts,ends FROM admin_effects WHERE id=?',
        key.slice(7),
      ) ?? null
    );
  }
  if (key.startsWith('event:')) {
    return (
      engine.db.one<Record<string, SqlStorageValue>>(
        'SELECT * FROM scheduled_events WHERE id=?',
        key.slice(6),
      ) ?? null
    );
  }
  if (key === 'selector-roster') {
    return engine.db.roster().map(id => initial['player:' + id]);
  }
  return undefined;
}

/** 确认计划保存的命令、依赖和变化；执行时必须再次校验有效性。 */
export interface PlanData {
  node: CommandNode;
  reason: string;
  dependencies: Record<string, unknown>;
  preview: ManagementPreview;
  result?: OperationResult;
}

/** 捕获命令审计所需的状态事实，不向普通客户端直接泄露此快照。 */
export function commandState(engine: Engine): Record<string, unknown> {
  return {
    ...managementState(engine),
    objects: engine.db.all<Record<string, SqlStorageValue>>(
      'SELECT id,kind,actor,status,version,created_utc FROM command_objects ORDER BY id',
    ),
    tags: engine.db.all<Record<string, SqlStorageValue>>(
      'SELECT * FROM command_tags ORDER BY player_id,tag',
    ),
  };
}

/** 从实际执行变化提取目标集合，避免只记录语法选择器而丢失真实对象。 */
export function actualTargets(changes: ManagementPreview['changes']): string[] {
  return [
    ...new Set(
      changes
        .map(change =>
          /^C\d{2,3}$/.test(change.target) ? change.target : null,
        )
        .filter((id): id is string => id !== null),
    ),
  ];
}
