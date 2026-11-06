import {parseJson} from '../../../../packages/contracts/src/backend';
import {recordCommand} from './command_audit';
import {updateCommandObject} from './command_context';
import {
  runCommandEventStep,
  type CommandEventContext,
} from './command_event_context';
import type {TaskData} from './command_runtime';
import {actualTargets, commandState} from './command_runtime';
import {autoFinish} from './life';

/** 按原时间和迟到策略执行单次授权任务，保留失败并清理目标快照。 */
export function executeCommandTask(context: CommandEventContext): void {
  const {engine, event, row, actor, commandContext} = context;
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
    const result = runCommandEventStep(commandContext, data.node);
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
