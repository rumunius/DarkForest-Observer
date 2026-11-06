import {parseJson} from '../../../../packages/contracts/src/backend';
import {recordCommand} from './command_audit';
import {requireCommandArgument, updateCommandObject} from './command_context';
import {
  runCommandEventStep,
  type CommandEventContext,
} from './command_event_context';
import type {JobData} from './command_runtime';
import {actualTargets, commandState, isMessage} from './command_runtime';
import {autoFinish} from './life';

/** 复核逐步作业位置与赛后门禁，保存本步结果或失败并安排下一步。 */
export function executeCommandJob(context: CommandEventContext): void {
  const {engine, event, payload, row, actor, commandContext} = context;
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
    const result = runCommandEventStep(commandContext, data.steps[data.next]!);
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
