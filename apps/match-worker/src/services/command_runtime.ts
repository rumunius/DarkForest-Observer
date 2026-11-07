import type {ManagementPreview, OperationResult} from '@darkforest/contracts';
import {parseJson} from '../../../../packages/contracts/src/backend';
import {
  COMMAND_LIMITS,
  commandSpec,
  type CommandNode,
} from '../../../../packages/contracts/src/commands';
import {Fault, permission, type Actor} from '../storage/store';
import {runBatch, runConditional} from './command_composition';
import type {CommandContext} from './command_context';
import {
  captureCommandDependencies,
  commandObject,
  eventDependencies,
  recordDependency,
  requireCommandArgument,
  validateCommandOptions,
} from './command_context';
import {cancelCommandTask, executeCommandAction} from './command_execution';
import {defineMacro, retireMacro, runMacro} from './command_macros';
import {query} from './command_query';
import {createJob, createSchedule} from './command_schedule';
import {type Engine, type PreparedCode} from './engine';
import {survivors} from './life';
import {managementState} from './management_impact';

export {pin} from './command_macros';
export {isMessage, type JobData, type TaskData} from './command_schedule';

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
      return defineMacro(commandContext, commandNode);
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
  if (Object.hasOwn(initial, key)) {
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
