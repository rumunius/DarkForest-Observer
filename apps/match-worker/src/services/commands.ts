import type {OperationResult} from '@darkforest/contracts';
import {
  parseJson,
  strict,
  text,
} from '../../../../packages/contracts/src/backend';
import {
  COMMAND_LIMITS,
  commandSpec,
  parseCommandTree,
  type CommandNode,
} from '../../../../packages/contracts/src/commands';
import {
  permission,
  requireThat,
  type Actor,
  type Scheduled,
} from '../storage/store';
import {prepareCredential} from './accounts';
import {recordCommand} from './command_audit';
import {
  commandObject,
  requireCommandArgument,
  updateCommandObject,
  validateCommandOptions,
} from './command_context';
import {
  confirmCommandPlan,
  inspectCommandPlan,
  previewCommandRequest,
} from './command_plans';
import {page, queryTables} from './command_query';
import type {
  CommandExecutionContext,
  CommandRequestContext,
} from './command_request_context';
import {
  inspectCommandRequest,
  queryCommandRequest,
  saveDirectCommand,
} from './command_request_reads';
import type {JobData, TaskData} from './command_runtime';
import {
  actualTargets,
  commandState,
  createCommandContext,
  isMessage,
  pin,
  run,
} from './command_runtime';
import {type Engine, type PreparedCode} from './engine';
import {autoFinish} from './life';

export {recordCommand} from './command_audit';
export {condition} from './command_conditions';

/** 通过受限分页器读取真实命令日志，不开放任意SQL或跨权限历史。 */
export function readCommandHistory(
  engine: Engine,
  actor: Actor,
  options: Record<string, string> = {},
): unknown {
  permission(actor, 'audit');
  const node: CommandNode = {words: ['command', 'history'], options};
  validateCommandOptions(node);
  return page(
    createCommandContext(engine, actor, 'history-read', []),
    node,
    'judge_command_log',
    queryTables.command!.columns,
  );
}

/** 共享命令语法解析入口；解析成功不代表已经授权或执行。 */
export const parseCommand = parseCommandTree;

/** 处理查询、预览、确认与取消；执行时在权威事务中复核依赖和权限。 */
export function commandAction(
  engine: Engine,
  actor: Actor,
  id: string,
  path: string,
  raw: Record<string, unknown>,
  prepared: PreparedCode[],
  keys: Awaited<ReturnType<Engine['keys']>>,
  ciphertext: string | null = null,
): OperationResult {
  engine.resolvedKeys = keys;
  requireThat(
    actor.role === 'judge',
    'FORBIDDEN',
    '只有裁判可以执行指令。',
    403,
  );
  permission(actor, 'overview');
  strict(raw, [
    'request_id',
    'command',
    'reason',
    'expected_revision',
    'preview_token',
  ]);
  let node = parseCommandTree(text(raw.command, COMMAND_LIMITS.bytes));
  let spec = commandSpec(node);
  requireCommandArgument(spec, '无法识别命令，请输入/help');
  const context: CommandRequestContext = {
    engine,
    actor,
    id,
    path,
    raw,
    prepared,
    ciphertext,
  };
  if (node.words[0] === 'request') {
    return inspectCommandRequest(context, node, spec);
  }
  if (
    node.words[0] === 'plan' &&
    ['inspect', 'cancel'].includes(node.words[1]!)
  ) {
    return inspectCommandPlan(context, node, spec);
  }
  if (node.words[0] === 'confirm' || raw.preview_token) {
    return confirmCommandPlan(context, node);
  }
  let explicit = node.words[0] === 'plan';
  if (explicit) {
    node = {...node, words: node.words.slice(1)};
    spec = commandSpec(node);
    requireCommandArgument(spec && !spec.query, 'plan需要一个写操作');
  }
  const reason =
    node.options.reason ??
    (typeof raw.reason === 'string' && raw.reason.trim()
      ? raw.reason
      : '裁判主动干预');
  const executionContext = createCommandContext(engine, actor, id, prepared);
  executionContext.reason = reason;
  const execution: CommandExecutionContext = {
    ...context,
    node,
    spec,
    reason,
    executionContext,
  };
  if (spec.query) {
    return queryCommandRequest(execution);
  }
  // Fixed macro versions are stored in the plan, never resolved again after confirmation.
  if (spec.path !== 'macro define') {
    pin(executionContext, node);
  }
  if (spec.direct && !explicit && !path.endsWith('/preview')) {
    return saveDirectCommand(execution);
  }
  explicit = explicit || path.endsWith('/preview');
  void explicit;
  return previewCommandRequest(execution);
}

/** 在事务外准备命令需要的凭据，执行时仍必须核对最新授权。 */
export async function prepareCommandCredentials(
  engine: Engine,
  creators: string[],
): Promise<void> {
  const accounts = engine.db.all<{id: string}>(
    "SELECT id FROM accounts WHERE instr(permissions,'system')=0",
  );
  const entries = await Promise.all(
    [...new Set(creators)].flatMap(actor =>
      accounts.map(
        async account =>
          [
            `${actor}:${account.id}`,
            await prepareCredential(engine, actor),
          ] as const,
      ),
    ),
  );
  engine.commandCredentials = Object.fromEntries(entries);
}

/** 执行持久命令任务并复核创建者权限、时间与依赖，失败留存供裁判处置。 */
export function executeCommandEvent(engine: Engine, event: Scheduled): void {
  const payload = parseJson(event.payload) as {
    id?: string;
    job?: string;
    index?: number;
  };
  const row = commandObject(
    engine,
    payload.id ?? payload.job!,
    payload.job ? 'job' : 'schedule',
  );
  if (row.status !== 'pending') {
    return;
  }
  const actor = engine.db.one<Actor>(
    'SELECT * FROM accounts WHERE id=?',
    row.actor,
  );
  if (
    engine.db.one<Record<string, SqlStorageValue>>(
      'SELECT id FROM match_identity',
    ) &&
    !engine.taskAuthorization.has(row.actor)
  ) {
    engine.db.exec(
      "UPDATE command_objects SET status='review',version=version+1 WHERE id=?",
      row.id,
    );
    return;
  }
  if (!actor?.enabled) {
    engine.db.exec(
      "UPDATE command_objects SET status='failed' WHERE id=?",
      row.id,
    );
    if (actor) {
      recordCommand(
        engine,
        actor,
        row.id,
        payload.job ? 'job step' : 'schedule due',
        'rejected',
        {
          parent: row.id,
          eventId: event.id,
          code: 'AUTHOR_DISABLED',
          originalDue: event.due,
        },
        null,
      );
    }
    return;
  }
  const commandContext = createCommandContext(
    engine,
    actor,
    `${row.id}-${payload.index ?? 0}`,
    engine.commandPrepared,
  );
  commandContext.reason = '裁判定时授权';
  commandContext.deferred = true;
  if (payload.job) {
    const data = parseJson(row.data) as JobData;
    requireCommandArgument(data.next === payload.index, '作业进度不一致');
    if (
      engine.db.match().phase === 'ended' &&
      !isMessage(engine, data.steps[data.next]!)
    ) {
      updateCommandObject(commandContext, row, data, 'cancelled');
      recordCommand(
        engine,
        actor,
        row.id,
        'job step',
        'cancelled',
        {
          parent: row.id,
          index: data.next,
          eventId: event.id,
          reason: '比赛已结束',
        },
        null,
      );
      return;
    }
    commandContext.reason = data.reason;
    const stateBefore = commandState(engine);
    try {
      const result = engine.db.tx(() => {
        const prior = engine.commandBatch;
        engine.commandBatch = true;
        try {
          return run(commandContext, data.steps[data.next]!);
        } finally {
          engine.commandBatch = prior;
        }
      });
      autoFinish(engine, engine.game(), engine.now(), row.id);
      data.results.push(result ?? null);
      data.next++;
      updateCommandObject(
        commandContext,
        row,
        data,
        data.next === data.steps.length ? 'complete' : 'pending',
      );
      if (data.next < data.steps.length) {
        engine.schedule(
          `${row.id}:${data.next}`,
          'judge_command_job',
          'utc',
          engine.now() + 1,
          3,
          {
            job: row.id,
            index: data.next,
          },
        );
      }
      recordCommand(
        engine,
        actor,
        row.id,
        'job step',
        'executed',
        {
          parent: row.id,
          index: payload.index,
          eventId: event.id,
          reason: commandContext.reason,
          source: commandContext.source,
          targets: actualTargets(commandContext.changes),
          changes: commandContext.changes,
          before: stateBefore,
          after: commandState(engine),
          result,
        },
        null,
      );
    } catch (error) {
      data.error = error instanceof Error ? error.message : '步骤失败';
      updateCommandObject(commandContext, row, data, 'failed');
      recordCommand(
        engine,
        actor,
        row.id,
        'job step',
        'failed',
        {
          parent: row.id,
          eventId: event.id,
          reason: commandContext.reason,
          before: stateBefore,
          after: commandState(engine),
          index: data.next,
          error: data.error,
        },
        null,
      );
    }
    return;
  }
  const data = parseJson(row.data) as TaskData;
  if (engine.db.match().phase === 'ended' && data.afterEnd === 'cancel') {
    updateCommandObject(commandContext, row, data, 'cancelled');
    recordCommand(
      engine,
      actor,
      row.id,
      'schedule due',
      'cancelled',
      {
        parent: row.id,
        eventId: event.id,
        originalDue: data.due,
        reason: '比赛已结束',
      },
      null,
    );
    return;
  }
  const lateness = Math.max(
    0,
    (event.clock === 'game' ? engine.game() : engine.now()) - event.due,
  );
  if (
    (lateness > 0 && data.late !== 'run') ||
    (data.maxLateness !== null && lateness > data.maxLateness)
  ) {
    updateCommandObject(
      commandContext,
      row,
      data,
      data.late === 'skip' ? 'skipped' : 'review',
    );
    recordCommand(
      engine,
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
  commandContext.reason = data.reason;
  commandContext.source = data.source;
  commandContext.caseId = data.caseId;
  engine.commandSnapshot = data.snapshot;
  const stateBefore = commandState(engine);
  try {
    const result = engine.db.tx(() => {
      const prior = engine.commandBatch;
      engine.commandBatch = true;
      try {
        return run(commandContext, data.node);
      } finally {
        engine.commandBatch = prior;
      }
    });
    autoFinish(engine, engine.game(), engine.now(), row.id);
    data.results = result;
    updateCommandObject(commandContext, row, data, 'complete');
    recordCommand(
      engine,
      actor,
      row.id,
      'schedule due',
      'executed',
      {
        parent: row.id,
        eventId: event.id,
        originalDue: data.due,
        lateness,
        reason: commandContext.reason,
        source: commandContext.source,
        caseId: commandContext.caseId ?? null,
        targets: actualTargets(commandContext.changes),
        changes: commandContext.changes,
        before: stateBefore,
        after: commandState(engine),
        result,
      },
      null,
    );
  } catch (error) {
    data.error = error instanceof Error ? error.message : '定时操作失败';
    updateCommandObject(commandContext, row, data, 'failed');
    recordCommand(
      engine,
      actor,
      row.id,
      'schedule due',
      'failed',
      {
        parent: row.id,
        eventId: event.id,
        error: data.error,
        reason: commandContext.reason,
        before: stateBefore,
        after: commandState(engine),
      },
      null,
    );
  } finally {
    engine.commandSnapshot = {};
  }
}
