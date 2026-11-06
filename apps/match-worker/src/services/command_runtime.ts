import type {ManagementPreview, OperationResult} from '@darkforest/contracts';
import {
  integer,
  parseJson,
  text,
} from '../../../../packages/contracts/src/backend';
import {
  COMMAND_LIMITS,
  commandSpec,
  durationMs,
  instantMs,
  type CommandNode,
} from '../../../../packages/contracts/src/commands';
import {Fault, permission, type Actor} from '../storage/store';
import {condition} from './command_conditions';
import type {CommandContext} from './command_context';
import {
  validateCommandArguments,
  captureCommandDependencies,
  recordChange,
  recordDependency,
  eventDependencies,
  requireHeadJudge,
  namedCommandObject,
  requireCommandArgument,
  commandObject,
  validateCommandOptions,
  requireObjectOwner,
  saveCommandObject,
  selectTargets,
  unquoteArgument,
  updateCommandObject,
  commandValue,
} from './command_context';
import {dispatchCommandAction} from './command_dispatch';
import {query} from './command_query';
import {targets} from './command_targets';
import {type Engine, type PreparedCode} from './engine';
import {logEvent, survivors} from './life';
import {managementState} from './management_impact';

interface MacroData {
  name: string;
  params: Array<{name: string; type: string}>;
  block: CommandNode[];
}

/** 固定组合命令所引用的宏版本，避免确认前模板变化悄然改变执行内容。 */
export function pin(
  commandContext: CommandContext,
  n: CommandNode,
  stack: string[] = [],
): void {
  const spec = commandSpec(n);
  requireCommandArgument(spec, '未注册的命令');
  validateCommandOptions(n);
  permission(commandContext.actor, spec.permission);
  requireCommandArgument(
    !['plan', 'confirm', 'request'].includes(n.words[0]!) && !spec.query,
    '授权控制及查询不能嵌入操作块',
  );
  if (spec.path === 'macro run') {
    const name = unquoteArgument(n.words[2]);
    const versionIndex = n.words.indexOf('version');
    const row = namedCommandObject(
      commandContext,
      'macro',
      name,
      versionIndex >= 0 ? Number(n.words[versionIndex + 1]) : undefined,
    );
    requireCommandArgument(!stack.includes(name), '宏不能直接或间接递归');
    const data = parseJson(row.data) as MacroData;
    if (versionIndex < 0) {
      n.words.push('version', String(row.version));
    }
    for (const node of data.block) {
      pin(commandContext, node, [...stack, name]);
    }
  }
  for (const child of n.block ?? []) {
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
export function run(commandContext: CommandContext, n: CommandNode): unknown {
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
    validateCommandOptions(n);
    const spec = commandSpec(n)!;
    permission(commandContext.actor, spec.permission);
    commandContext.reason = n.options.reason ?? commandContext.reason;
    commandContext.source = n.options.source ?? commandContext.source;
    commandContext.caseId = n.options.case ?? commandContext.caseId;
    if (commandContext.caseId) {
      const record = commandObject(
        commandContext.e,
        commandContext.caseId,
        'case',
      );
      recordDependency(commandContext, 'object:' + record.id, record);
    }
    if (spec.query) {
      return query(commandContext, n);
    }
    if (spec.path === 'batch run') {
      requireCommandArgument(
        n.words.length === 2 && n.block?.length,
        '用法：batch run { 操作; ... }',
      );
      if (n.options.mode) {
        requireCommandArgument(
          ['atomic', 'sequential'].includes(n.options.mode),
          'mode须为atomic或sequential',
        );
      }
      if (n.options.mode === 'sequential') {
        return createJob(commandContext, n.block);
      }
      const results = [];
      for (const child of n.block) {
        results.push(run(commandContext, child));
      }
      return results;
    }
    if (spec.path === 'execute') {
      requireCommandArgument(
        n.block?.length && n.words.at(-1) === 'run',
        'execute需要run操作块',
      );
      let index = 1;
      let ids: Array<string | undefined> = [commandContext.self];
      if (n.words[index] === 'as') {
        ids = selectTargets(commandContext, n.words[index + 1]!);
        index += 2;
      }
      const steps: Array<{unless: boolean; words: string[]}> = [];
      while (index < n.words.length - 1) {
        const kind = n.words[index++];
        requireCommandArgument(
          kind === 'if' || kind === 'unless',
          'execute需要as/if/unless/run',
        );
        const start = index;
        let depth = 0;
        while (index < n.words.length - 1) {
          const w = n.words[index]!;
          if (w === '(') {
            depth++;
          }
          if (w === ')') {
            depth--;
          }
          if (!depth && ['if', 'unless'].includes(w)) {
            break;
          }
          index++;
        }
        steps.push({
          unless: kind === 'unless',
          words: n.words.slice(start, index),
        });
      }
      const out = [];
      for (const id of ids) {
        commandContext.self = id;
        let enabled = true;
        for (const step of steps) {
          const matches = condition(commandContext, step.words);
          enabled = enabled && (step.unless ? !matches : matches);
        }
        if (enabled) {
          for (const child of n.block) {
            out.push(run(commandContext, child));
          }
        } else {
          commandContext.notes.push(`条件为假：${id ?? '全局'}，无操作。`);
        }
      }
      return out;
    }
    if (spec.path === 'macro define') {
      requireHeadJudge(commandContext);
      requireCommandArgument(
        n.block?.length && n.words.at(-1) === 'run',
        '宏定义需要run操作块',
      );
      const name = commandValue(n.words[2], commandContext);
      text(name, 200);
      const params: Array<{name: string; type: string}> = [];
      if (n.words.length > 4) {
        requireCommandArgument(
          n.words[3] === 'params' &&
            n.words[4] === '(' &&
            n.words.at(-2) === ')',
          '宏参数须使用params (...)',
        );
        const declarations = n.words.slice(5, -2).join('').split(',');
        for (const decl of declarations) {
          const match =
            /^([A-Za-z][A-Za-z0-9_]*):(target|int|duration|text|bool)$/.exec(
              decl,
            );
          requireCommandArgument(
            match && !params.some(p => p.name === match[1]),
            '宏参数类型、名称或重复声明不正确',
          );
          params.push({name: match[1]!, type: match[2]!});
        }
      }
      const block = structuredClone(n.block);
      for (const node of block) {
        requireCommandArgument(
          !(
            node.words[0] === 'macro' && unquoteArgument(node.words[2]) === name
          ),
          '宏不能递归',
        );
        pin(commandContext, node, [name]);
      }
      const versions = commandContext.e.db.all<{version: number}>(
        "SELECT version FROM command_objects WHERE kind='macro' AND json_extract(data,'$.name')=?",
        name,
      );
      const version = Math.max(0, ...versions.map(v => v.version)) + 1;
      const id = saveCommandObject(
        commandContext,
        'macro',
        {name, params, block},
        'MAC',
      );
      commandContext.e.db.exec(
        'UPDATE command_objects SET version=? WHERE id=?',
        version,
        id,
      );
      recordChange(
        commandContext,
        id,
        '原版本保留',
        `宏「${name}」版本${version}已保存，尚未执行`,
      );
      return {id, version};
    }
    if (spec.path === 'macro run') {
      const name = commandValue(n.words[2], commandContext);
      const v = n.words.indexOf('version');
      const row = namedCommandObject(
        commandContext,
        'macro',
        name,
        v >= 0 ? Number(n.words[v + 1]) : undefined,
      );
      const data = parseJson(row.data) as MacroData;
      recordDependency(commandContext, 'object:' + row.id, row);
      requireCommandArgument(
        !commandContext.macroStack.includes(row.id),
        '宏不能递归',
      );
      const rest = n.words.slice(3, v >= 0 ? v : undefined);
      const args: string[] = [];
      if (rest.length) {
        requireCommandArgument(
          rest[0] === '(' && rest.at(-1) === ')',
          '宏参数须在括号内',
        );
        let current: string[] = [];
        for (const word of rest.slice(1, -1)) {
          if (word === ',') {
            args.push(current.join(''));
            current = [];
          } else {
            current.push(word);
          }
        }
        if (current.length) {
          args.push(current.join(''));
        }
      }
      requireCommandArgument(
        args.length === data.params.length,
        '宏实参数量与声明不一致',
      );
      commandContext.bindings = {...commandContext.bindings};
      commandContext.scalars = {...commandContext.scalars};
      for (const [i, p] of data.params.entries()) {
        const arg = commandValue(args[i], commandContext);
        const key = '$' + p.name;
        if (p.type === 'target') {
          commandContext.bindings[key] = selectTargets(commandContext, arg);
        } else {
          if (p.type === 'int') {
            integer(Number(arg), Number.MIN_SAFE_INTEGER);
          }
          if (p.type === 'duration') {
            durationMs(arg);
          }
          if (p.type === 'bool') {
            requireCommandArgument(
              ['true', 'false'].includes(arg),
              '宏布尔参数须为true/false',
            );
          }
          commandContext.scalars[key] = arg;
        }
      }
      commandContext.macroStack.push(row.id);
      try {
        return data.block.map(child => run(commandContext, child));
      } finally {
        commandContext.macroStack.pop();
      }
    }
    if (spec.path === 'macro retire') {
      requireHeadJudge(commandContext);
      validateCommandArguments(n);
      const row = namedCommandObject(
        commandContext,
        'macro',
        commandValue(n.words[2], commandContext),
        integer(Number(n.words[4]), 1),
      );
      updateCommandObject(commandContext, row, parseJson(row.data), 'retired');
      recordChange(commandContext, row.id, 'active', 'retired');
      return;
    }
    if (spec.path === 'schedule create') {
      return createSchedule(commandContext, n);
    }
    if (spec.path === 'schedule cancel' || spec.path === 'job cancel') {
      validateCommandArguments(n);
      const row = commandObject(
        commandContext.e,
        commandValue(n.words[2], commandContext),
        spec.path.startsWith('job') ? 'job' : 'schedule',
      );
      requireObjectOwner(commandContext, row);
      if (['complete', 'cancelled'].includes(row.status)) {
        return parseJson(row.data);
      }
      updateCommandObject(
        commandContext,
        row,
        parseJson(row.data),
        'cancelled',
      );
      commandContext.e.db.exec(
        "UPDATE scheduled_events SET status='cancelled' WHERE (id=? OR json_extract(payload,'$.job')=?) AND status='pending'",
        row.id,
        row.id,
      );
      recordChange(
        commandContext,
        row.id,
        row.status,
        'cancelled；已提交步骤不回滚',
      );
      return;
    }
    const offset = commandContext.changes.length;
    const result = dispatchCommandAction(commandContext, n);
    const changes = commandContext.changes.slice(offset);
    const ids = [
      ...new Set(
        changes.map(p => p.target).filter(id => /^C\d{2,3}$/.test(id)),
      ),
    ];
    commandContext.e.audit(
      commandContext.actor.id,
      'command:' + spec.path,
      ids.length === 1 ? ids[0]! : commandContext.e.db.match().id,
      commandContext.reason,
      {
        requestId: commandContext.id,
        source: commandContext.source,
        caseId: commandContext.caseId ?? null,
        status: 'executed',
        changes,
      },
    );
    if (changes.length) {
      logEvent(
        commandContext.e,
        `command:${commandContext.actor.id}:${commandContext.id}:${commandContext.work}`,
        'review',
        /^(resource|photon|tech) /.test(spec.path) ? '资源调整' : '裁判指令',
        commandContext.reason,
        'global',
        ids,
        commandContext.e.game(),
        commandContext.e.now(),
      );
    }
    return result;
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

function macroBody(engine: Engine, n: CommandNode): CommandNode[] | undefined {
  if (commandSpec(n)?.path !== 'macro run') {
    return;
  }
  const v = n.words.indexOf('version');
  const row = engine.db.one<{data: string}>(
    "SELECT data FROM command_objects WHERE kind='macro' AND json_extract(data,'$.name')=? AND version=?",
    unquoteArgument(n.words[2]),
    Number(n.words[v + 1]),
  );
  return row ? (parseJson(row.data) as MacroData).block : undefined;
}

/** 判断命令树是否仅产生管理消息，用于完赛后保留通知任务的策略。 */
export function isMessage(engine: Engine, n: CommandNode): boolean {
  if (
    ['announce', 'tell', 'notice', 'reveal', 'replay'].includes(n.words[0]!)
  ) {
    return true;
  }
  const block =
    macroBody(engine, n) ??
    (['batch', 'execute'].includes(n.words[0]!) ? n.block : undefined);
  if (block) {
    return block.every(child => isMessage(engine, child));
  }
  return false;
}

function collectSnapshot(
  commandContext: CommandContext,
  n: CommandNode,
  result: Record<string, string[]>,
): void {
  for (const w of n.words) {
    if (/^@(a|alive|dead|random|pool)(\[|$)/.test(w)) {
      result[w] = targets(
        commandContext.e,
        w,
        commandContext.self,
        true,
        commandContext.bindings,
      ).candidates;
    }
  }
  for (const child of n.block ?? []) {
    collectSnapshot(commandContext, child, result);
  }
  for (const child of macroBody(commandContext.e, n) ?? []) {
    collectSnapshot(commandContext, child, result);
  }
}

function createSchedule(
  commandContext: CommandContext,
  n: CommandNode,
): unknown {
  requireCommandArgument(
    (n.block?.length && n.words.length === 7 && n.words[5] === 'run') ||
      (n.block?.length && n.words.length === 6 && n.words[5] === 'run'),
    '用法：schedule create utc|game in|at 时间 run { 操作 }',
  );
  const clock = n.words[2];
  const mode = n.words[3];
  const raw = commandValue(n.words[4], commandContext);
  requireCommandArgument(
    clock === 'utc' || clock === 'game',
    '时基为utc或game',
  );
  requireCommandArgument(mode === 'at' || mode === 'in', '时间模式为at或in');
  const block = structuredClone(n.block);
  for (const node of block) {
    pin(commandContext, node);
  }
  let due: number;
  if (mode === 'in') {
    due =
      (clock === 'utc' ? commandContext.e.now() : commandContext.e.game()) +
      durationMs(raw);
  } else if (clock === 'utc') {
    due = instantMs(raw);
  } else {
    const m = /^g(\d+):([0-5]\d)(?:\.(\d{3}))?$/.exec(raw);
    requireCommandArgument(m, '游戏时刻须为g分:秒[.毫秒]');
    due = Number(m[1]) * 60000 + Number(m[2]) * 1000 + Number(m[3] ?? 0);
  }
  integer(due);
  const node: CommandNode = {words: ['batch', 'run'], block, options: {}};
  const message = isMessage(commandContext.e, node);
  const late = n.options.late ?? (message ? 'run' : 'review');
  const afterEnd = n.options['after-end'] ?? (message ? 'keep' : 'cancel');
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
    !n.options.targets || ['live', 'snapshot'].includes(n.options.targets),
    'targets为live或snapshot',
  );
  const snapshot: Record<string, string[]> = {};
  if (n.options.targets === 'snapshot') {
    collectSnapshot(commandContext, node, snapshot);
  }
  const data: TaskData = {
    node,
    due,
    clock,
    late: late as TaskData['late'],
    maxLateness: n.options['max-lateness']
      ? durationMs(n.options['max-lateness'])
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
  commandContext.e.schedule(id, 'judge_command_task', clock, due, 3, {id});
  recordChange(
    commandContext,
    id,
    '无定时任务',
    `${clock === 'utc' ? new Date(due).toLocaleString('zh-CN', {timeZone: 'Asia/Shanghai'}) + ' 北京时间' : `有效比赛${due}毫秒`}；目标${n.options.targets ?? 'live'}；迟到${late}；赛后${afterEnd}`,
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
  commandContext.e.schedule(
    `${id}:0`,
    'judge_command_job',
    'utc',
    commandContext.e.now(),
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
  const m = engine.db.match();
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
    e: engine,
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

/** 在可回滚的预览执行中收集真实变化与依赖，不把模拟结果直接当作提交。 */
export function simulate(
  engine: Engine,
  actor: Actor,
  id: string,
  node: CommandNode,
  prepared: PreparedCode[],
  reason: string,
): CommandContext {
  const c = createCommandContext(engine, actor, id, prepared, true);
  const rollback = new Error('COMMAND_PREVIEW_ROLLBACK');
  c.reason = reason;
  const previous = engine.commandBatch;
  engine.commandBatch = true;
  try {
    engine.db.tx(() => {
      run(c, node);
      const count = survivors(engine).length;
      if (engine.db.match().start_settled !== null && count <= 1) {
        c.notes.push(`整批结束后存活${count}人，将提前完赛。`);
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
  return c;
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
