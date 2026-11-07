import type {ManagementPreview, OperationResult} from '@darkforest/contracts';
import {
  parseJson,
  stableJson,
  text,
} from '../../../../packages/contracts/src/backend';
import type {CommandSpec} from '../../../../packages/contracts/src/commands';
import {
  commandSpec,
  type CommandNode,
} from '../../../../packages/contracts/src/commands';
import {permission, requireThat} from '../storage/store';
import {recordCommand} from './command_audit';
import {
  commandObject,
  requireCommandArgument,
  requireObjectOwner,
} from './command_context';
import type {
  CommandExecutionContext,
  CommandRequestContext,
} from './command_request_context';
import type {PlanData} from './command_runtime';
import {
  actualTargets,
  commandState,
  createCommandContext,
  currentDependency,
  run,
  simulate,
} from './command_runtime';
import {completed} from './engine';
import {autoFinish} from './life';

/** 复核计划归属及对应职责后读取或关闭尚未执行的计划。 */
export function inspectCommandPlan(
  context: CommandRequestContext,
  node: CommandNode,
  spec: CommandSpec,
): OperationResult {
  const {engine, actor, id, prepared, ciphertext} = context;

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

/** 确认本人原计划，重放已完成结果或复核依赖后提交并记录真实状态。 */
export function confirmCommandPlan(
  context: CommandRequestContext,
  node: CommandNode,
): OperationResult {
  const {engine, actor, id, raw, prepared, ciphertext} = context;

  const token =
    node.words[0] === 'confirm' ? node.words[1]! : text(raw.preview_token, 100);
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

/** 在可回滚模拟后保存原命令、依赖及影响，正式确认仍重新检查。 */
export function previewCommandRequest(
  context: CommandExecutionContext,
): OperationResult {
  const {
    engine,
    actor,
    id,
    prepared,
    ciphertext,
    node,
    spec,
    reason,
    executionContext,
  } = context;
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
