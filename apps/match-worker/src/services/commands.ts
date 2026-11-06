import type {ManagementPreview, OperationResult} from '@darkforest/contracts';
import {
  parseJson,
  stableJson,
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
import {
  requireCommandArgument,
  commandObject,
  validateCommandOptions,
  requireObjectOwner,
  updateCommandObject,
} from './command_context';
import {page, query, queryTables} from './command_query';
import type {JobData, PlanData, TaskData} from './command_runtime';
import {
  actualTargets,
  commandState,
  createCommandContext,
  currentDependency,
  isMessage,
  pin,
  run,
  simulate,
} from './command_runtime';
import {completed, type Engine, type PreparedCode} from './engine';
import {autoFinish} from './life';

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
  if (node.words[0] === 'request') {
    requireCommandArgument(
      node.words.length === 3 && node.words[1] === 'inspect',
      '用法：request inspect REQ-ID',
    );
    const result = engine.result(actor, node.words[2]!);
    recordCommand(
      engine,
      actor,
      id,
      spec.path,
      'queried',
      {
        reference: node.words[2],
        watermark: engine.db.match().revision,
        resultStatus: result.status,
      },
      ciphertext,
    );
    return result;
  }
  if (
    node.words[0] === 'plan' &&
    ['inspect', 'cancel'].includes(node.words[1]!)
  ) {
    const row = commandObject(engine, node.words[2]!, 'plan');
    requireObjectOwner(createCommandContext(engine, actor, id, prepared), row);
    const data = parseJson(row.data) as PlanData;
    permission(actor, commandSpec(data.node)!.permission);
    if (node.words[1] === 'cancel') {
      requireCommandArgument(row.status === 'pending', '只能关闭未执行计划');
      engine.db.exec(
        "UPDATE command_objects SET status='cancelled' WHERE id=?",
        row.id,
      );
    }
    recordCommand(
      engine,
      actor,
      id,
      spec.path,
      node.words[1] === 'cancel' ? 'cancelled' : 'queried',
      {
        plan: row.id,
        before: {status: row.status},
        after: {status: node.words[1] === 'cancel' ? 'cancelled' : row.status},
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
    const token =
      node.words[0] === 'confirm'
        ? node.words[1]!
        : text(raw.preview_token, 100);
    const row = commandObject(engine, token, 'plan');
    requireCommandArgument(row.actor === actor.id, '计划必须由创建裁判确认');
    const data = parseJson(row.data) as PlanData;
    if (raw.preview_token) {
      requireCommandArgument(
        stableJson(node) === stableJson(data.node),
        '输入与已预览计划不一致',
      );
    }
    if (row.status === 'complete') {
      requireCommandArgument(data.result, '计划结果缺失');
      recordCommand(
        engine,
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
      return {...data.result, requestId: id};
    }
    requireCommandArgument(row.status === 'pending', '该计划已关闭或失效');
    const commandContext = createCommandContext(engine, actor, id, prepared);
    commandContext.reason = data.reason;
    for (const [key, before] of Object.entries(data.dependencies)) {
      const current =
        key === 'match' || key === 'permissions'
          ? commandContext.dependencies[key]
          : currentDependency(engine, key, commandContext.initial);
      requireThat(
        stableJson(before) === stableJson(current),
        'PLAN_DEPENDENCY_CHANGED',
        '计划依赖已变化，请重新预览：' + key,
      );
    }
    // Revalidate all current business conditions, including UTC cutoffs, before drawing or writing.
    simulate(engine, actor, `check-${id}`, data.node, prepared, data.reason);
    const stateBefore = commandState(engine);
    const previous = engine.commandBatch;
    engine.commandBatch = true;
    let result: unknown;
    try {
      result = run(commandContext, data.node);
    } finally {
      engine.commandBatch = previous;
    }
    autoFinish(engine, engine.game(), engine.now(), `judge:${actor.id}:${id}`);
    engine.db.bump();
    const response = completed(
      id,
      '指令已执行',
      JSON.stringify({
        result,
        changes: commandContext.changes,
        notes: commandContext.notes,
      }),
      {revision: engine.db.match().revision},
    );
    data.result = response;
    engine.db.exec(
      "UPDATE command_objects SET status='complete',data=? WHERE id=?",
      JSON.stringify(data),
      row.id,
    );
    recordCommand(
      engine,
      actor,
      id,
      commandSpec(data.node)!.path,
      commandContext.changes.length ? 'executed' : 'no_op',
      {
        plan: row.id,
        reason: data.reason,
        source: data.node.options.source ?? 'judge_intervention',
        caseId: data.node.options.case ?? null,
        targets: actualTargets(commandContext.changes),
        changes: commandContext.changes,
        preview: data.preview,
        parameters: {
          argumentCount: data.node.words.length,
          optionNames: Object.keys(data.node.options),
        },
        before: stateBefore,
        after: commandState(engine),
        result: {status: response.status, revision: response.revision, result},
      },
      ciphertext,
    );
    return response;
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
  if (spec.query) {
    validateCommandOptions(node);
    const result = query(executionContext, node);
    recordCommand(
      engine,
      actor,
      id,
      spec.path,
      'queried',
      {
        watermark: engine.db.match().revision,
        projection: spec.path,
        count: Array.isArray(result)
          ? result.length
          : result &&
              typeof result === 'object' &&
              'items' in result &&
              Array.isArray(result.items)
            ? result.items.length
            : 1,
        filters: Object.fromEntries(
          Object.entries(node.options).map(([key, value]) => [
            key,
            key === 'search' ? '检索词保存在加密原文' : value,
          ]),
        ),
        targets: Object.keys(executionContext.dependencies)
          .filter(key => key.startsWith('player:'))
          .map(key => key.slice(7)),
      },
      ciphertext,
    );
    return completed(id, '查询完成', JSON.stringify(result, null, 2));
  }
  // Fixed macro versions are stored in the plan, never resolved again after confirmation.
  if (spec.path !== 'macro define') {
    pin(executionContext, node);
  }
  if (spec.direct && !explicit && !path.endsWith('/preview')) {
    const stateBefore = commandState(engine);
    const result = run(executionContext, node);
    engine.db.bump();
    recordCommand(
      engine,
      actor,
      id,
      spec.path,
      'saved',
      {
        reason,
        source: executionContext.source,
        targets: actualTargets(executionContext.changes),
        changes: executionContext.changes,
        before: stateBefore,
        after: commandState(engine),
        result,
      },
      ciphertext,
    );
    return completed(
      id,
      '已保存',
      JSON.stringify({result, changes: executionContext.changes}),
    );
  }
  explicit = explicit || path.endsWith('/preview');
  void explicit;
  const previewContext = simulate(engine, actor, id, node, prepared, reason);
  const token = `PLAN-${crypto.randomUUID()}`;
  const preview: ManagementPreview = {
    token,
    revision: engine.db.match().revision,
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
  engine.db.exec(
    'INSERT INTO command_objects(id,kind,actor,status,created_utc,data) VALUES(?,?,?,?,?,?)',
    token,
    'plan',
    actor.id,
    'pending',
    engine.now(),
    JSON.stringify({
      node,
      reason,
      dependencies: previewContext.dependencies,
      preview,
    } satisfies PlanData),
  );
  recordCommand(
    engine,
    actor,
    id,
    spec.path,
    'previewed',
    {
      plan: token,
      reason,
      source: node.options.source ?? executionContext.source,
      preview,
      targets: actualTargets(previewContext.changes),
      parameters: {
        argumentCount: node.words.length,
        optionNames: Object.keys(node.options),
      },
    },
    ciphertext,
  );
  return completed(id, '请核对操作影响', `确认：/confirm ${token}`, {preview});
}

/** 写入命令结果与前后状态审计，原文密文按命令身份和操作ID绑定。 */
export function recordCommand(
  engine: Engine,
  actor: Actor,
  id: string,
  path: string,
  status: string,
  detail: unknown,
  ciphertext: string | null = null,
): void {
  const facts =
    detail && typeof detail === 'object'
      ? (detail as Record<string, unknown>)
      : {detail};
  let auditId: string | null = null;
  if (
    facts.before !== undefined &&
    facts.after !== undefined &&
    !['queried', 'previewed'].includes(status)
  ) {
    const targets = Array.isArray(facts.targets) ? facts.targets : [];
    engine.audit(
      actor.id,
      'command:' + path,
      targets.length === 1 ? String(targets[0]) : engine.db.match().id,
      typeof facts.reason === 'string' ? facts.reason : '裁判指令记录',
      {requestId: id, status, ...facts},
    );
    auditId = engine.db.one<{id: string}>(
      'SELECT id FROM audit_logs ORDER BY seq DESC LIMIT 1',
    )!.id;
  }
  engine.db.exec(
    'INSERT INTO judge_command_log(id,actor,request_id,status,path,created_utc,game_ms,detail,ciphertext) VALUES(?,?,?,?,?,?,?,?,?)',
    crypto.randomUUID(),
    actor.id,
    id,
    status,
    path,
    engine.now(),
    engine.game(),
    JSON.stringify({
      ...facts,
      auditId,
      identity: engine.db.one<Record<string, SqlStorageValue>>(
        'SELECT account_id,assignment_id,name FROM memberships WHERE local_id=?',
        actor.id,
      ) ?? {name: actor.name, legacySeat: true},
    }),
    ciphertext,
  );
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
export {condition} from './command_conditions';
